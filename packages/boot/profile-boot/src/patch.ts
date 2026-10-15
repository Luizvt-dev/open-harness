import { isPlainObject } from '@open-harness/cosmokit'
import { formatIssues, s, type Issue } from '@open-harness/schemastery'
import { parseDocument } from 'yaml'
import type { PluginEntry } from '@open-harness/cordis-plugin-loader'

/** Nome do ficheiro de patch em cada camada (bundle, perfil, home). */
export const PATCH_FILE = 'cordis.patch.yml'

/** Ficheiro `package.json` do perfil. */
export const PROFILE_MANIFEST = 'package.json'

// ---------------------------------------------------------------------------
// Erros
// ---------------------------------------------------------------------------

export class PatchError extends Error {
  constructor(
    message: string,
    readonly source?: string,
    readonly issues: Issue[] = [],
  ) {
    super(source ? `${source}: ${message}` : message)
    this.name = 'PatchError'
  }
}

export class ProfileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProfileError'
  }
}

// ---------------------------------------------------------------------------
// Expressões !!js
// ---------------------------------------------------------------------------

const JS_MARKER = Symbol('open-harness.js-expression')

interface JsExpression {
  readonly [JS_MARKER]: string
}

function isJsExpression(value: unknown): value is JsExpression {
  if (!isPlainObject(value)) return false
  return typeof (value as unknown as Record<symbol, unknown>)[JS_MARKER] === 'string'
}

/**
 * Expressão `!!js` avaliada **no boot** (não em tempo de compilação).
 * Por omissão corre no escopo global — `process.platform`, `process.env.X`, …
 * Os ficheiros de patch são configuração local de confiança (mesmo nível que código).
 */
export function defaultEvaluateJs(expression: string): unknown {
  const body = `return (${expression})`
  // eslint-disable-next-line no-new-func
  return (new Function(body) as () => unknown)()
}

/** Substitui todos os marcadores `!!js` por valores avaliados (percurso profundo). */
export function evaluateJs<T>(
  value: T,
  evaluate: (expression: string) => unknown,
  source?: string,
): T {
  if (isJsExpression(value)) {
    const expression = value[JS_MARKER]
    try {
      return evaluate(expression) as T
    } catch (error) {
      throw new PatchError(
        `failed to evaluate !!js expression "${expression}": ${(error as Error).message}`,
        source,
      )
    }
  }
  if (Array.isArray(value)) return value.map((item) => evaluateJs(item, evaluate, source)) as T
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) out[key] = evaluateJs(item, evaluate, source)
    return out as T
  }
  return value
}

// NOTA: tags de scalar NÃO podem declarar `collection` — o `findScalarTagByName`
// do yaml ignora qualquer tag com `collection` quando resolve um tag explícito.
const jsTag = {
  tag: 'tag:yaml.org,2002:js',
  resolve(value: string): unknown {
    return { [JS_MARKER]: value }
  },
}

// ---------------------------------------------------------------------------
// Esquemas
// ---------------------------------------------------------------------------

const RowSchema = s.object(
  {
    // `plugin: null` é meaningful: declara explicitamente uma linha só-de-config
    plugin: s.union([s.string(), s.literal(null)]).optional(),
    config: s.union([s.record(s.any()), s.literal(null)]).optional(),
    enabled: s.boolean().optional(),
    order: s.number().int().optional(),
    group: s.string().optional(),
    isolate: s.boolean().optional(),
    requires: s.array(s.string()).optional(),
  },
  { additional: 'forbid' },
)

/** Valor de uma linha: objecto, atalho string (plugin) ou `null` (defaults). */
const RowValueSchema = s.union([s.string(), s.literal(null), RowSchema])

/** Documento de patch inteiro: `rowId → linha`. */
const PatchSchema = s.record(RowValueSchema)

// ---------------------------------------------------------------------------
// Linha e camada
// ---------------------------------------------------------------------------

/** Uma linha **parcial** (resultado de UMA camada antes do merge). */
export interface RowPatch {
  id: string
  plugin?: string | null
  config?: Record<string, unknown> | null
  enabled?: boolean
  order?: number
  group?: string
  isolate?: boolean
  requires?: string[]
}

/** Uma linha final, pronta para o `PluginLoader`. */
export interface ComposedRow extends PluginEntry {
  /** Última camada que tocou nesta linha (diagnóstico). */
  source: string
  /** Directório base para resolver `plugin` (o do bundle que o declarou). */
  requireDir: string
}

export interface PatchLayer {
  /** `bundle:<spec>` | `profile` | `home` | `overlay:<path>` */
  source: string
  requireDir: string
  rows: RowPatch[]
}

export interface ParsePatchOptions {
  /** Origem para mensagens de erro (caminho do ficheiro). */
  source?: string
  /** Avaliador de expressões `!!js` injectável (testes/policy). */
  evaluate?: (expression: string) => unknown
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Lê um `cordis.patch.yml`: valida com esquema (`additional: 'forbid'` apanha
 * typos), avalia `!!js` e normaliza atalhos (`plugin: 'x'` / `null`).
 * Ficheiro vazio → `[]`.
 */
export function parsePatch(text: string, options: ParsePatchOptions = {}): RowPatch[] {
  const { source, evaluate = defaultEvaluateJs } = options
  const doc = parseDocument(text, { customTags: [jsTag as never] })
  if (doc.errors.length) {
    const first = doc.errors[0]!
    const position = first.linePos?.[0]
    const where = position ? ` (${position.line}:${position.col})` : ''
    throw new PatchError(`YAML syntax error: ${first.message}${where}`, source)
  }

  const raw = doc.toJS()
  if (raw === null || raw === undefined) return []

  const evaluated = evaluateJs(raw, evaluate, source)
  const result = PatchSchema.validate(evaluated)
  if (!result.ok) {
    throw new PatchError(`invalid patch: ${formatIssues(result.issues)}`, source, result.issues)
  }

  const rows: RowPatch[] = []
  for (const [id, value] of Object.entries(result.value)) {
    rows.push(normalizeRow(id, value))
  }
  return rows
}

function normalizeRow(id: string, value: string | null | Record<string, unknown>): RowPatch {
  if (value === null) return { id }
  if (typeof value === 'string') return { id, plugin: value }
  return { id, ...value }
}

// ---------------------------------------------------------------------------
// Merge: último-por-id vence, config substituída por inteiro
// ---------------------------------------------------------------------------

/**
 * Compõe camadas em ordem (bundles → perfil → home → overlays).
 *
 * Regras:
 * - **último-por-id vence** por `id`, mantendo a posição de primeira aparição;
 * - `config` é **substituído por inteiro** quando a camada declara a chave
 *   (`config:` vazio ou `null` reseta para `{}`) — nunca merge profundo;
 * - metadados (`plugin`, `enabled`, `order`, `group`, `isolate`, `requires`)
 *   só mudam se a camada os declarar explicitamente;
 * - o `requireDir` acompanha a camada que declarou o `plugin` (pnpm: os
 *   plugins vivem no `node_modules` do bundle, não do perfil).
 */
export function mergeLayers(layers: PatchLayer[]): ComposedRow[] {
  const merged = new Map<string, ComposedRow>()

  for (const layer of layers) {
    for (const patch of layer.rows) {
      const previous = merged.get(patch.id)
      merged.set(patch.id, mergeRow(previous, patch, layer))
    }
  }

  return [...merged.values()]
}

function mergeRow(previous: ComposedRow | undefined, patch: RowPatch, layer: PatchLayer): ComposedRow {
  const declaresPlugin = patch.plugin !== undefined
  return {
    id: patch.id,
    plugin: declaresPlugin ? patch.plugin! : (previous?.plugin ?? null),
    config: 'config' in patch ? (patch.config ?? {}) : (previous?.config ?? {}),
    enabled: patch.enabled ?? previous?.enabled ?? true,
    order: patch.order ?? previous?.order,
    group: patch.group ?? previous?.group,
    isolate: patch.isolate ?? previous?.isolate,
    requires: patch.requires ?? previous?.requires,
    source: layer.source,
    requireDir: declaresPlugin ? layer.requireDir : (previous?.requireDir ?? layer.requireDir),
  }
}
