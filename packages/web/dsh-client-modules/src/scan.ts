import { readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { ClientPlugin } from './types.js'

// ---------------------------------------------------------------------------
// Metade Node: descoberta dos plugins de UI.
//
// Um plugin de UI é um pacote do workspace que declara, no seu `package.json`:
//
//   "dsh": { "client": { "entry": "./dist/client.js", "slots": ["chat"] } }
//
// O `entry` é um módulo ES compilado (o mesmo `dist` que o Node consome). O
// host serve a pasta do `entry` em `/plugins/<id>/`, por isso imports relativos
// (`./slots.js`) e source maps continuam a resolver no navegador.
// ---------------------------------------------------------------------------

/** Forma esperada do campo `dsh.client` no `package.json`. */
export interface ClientField {
  /** Caminho relativo do módulo ES de entrada. Default `./dist/client.js`. */
  entry?: string
  /** Slots que o plugin preenche. */
  slots?: string[]
  /** Ordem de carregamento (menor primeiro). Default `100`. */
  order?: number
  /** Identificador curto; por omissão deriva-se do nome do pacote. */
  id?: string
}

/** Um plugin descoberto no disco, pronto a servir. */
export interface ScannedClient {
  /** Identificador curto único no boot. */
  id: string
  /** Nome npm do pacote (`@open-harness/dsh-client-ui-chat`). */
  packageName: string
  /** Directório servido em `/plugins/<id>/` (o do `entry`). */
  dir: string
  /** Nome do ficheiro de entrada dentro de `dir`. */
  entry: string
  /** Slots declarados, pela ordem. */
  slots: string[]
  /** Ordem de carregamento. */
  order: number
}

/** Prefixo por omissão do identificador derivado do nome do pacote. */
const DEFAULT_ORDER = 100

/**
 * Deriva o identificador curto de um pacote.
 *
 * `@open-harness/dsh-client-ui-chat` → `ui-chat`; `dsh-ui-chat` → `ui-chat`.
 * A regra é determinística para que dois arranques gerem o mesmo manifesto.
 */
export function derivePluginId(packageName: string): string {
  const short = packageName.replace(/^@[^/]+\//, '')
  return short
    .replace(/^dsh-client-/, '')
    .replace(/^dsh-/, '')
    .replace(/_/g, '-')
}

/** Lê o `package.json` de `dir`, ou `null` se não existir/for inválido. */
function readManifest(dir: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * Lê o campo `dsh.client` de um `package.json`.
 *
 * Devolve `null` quando o pacote não é plugin de UI. Um `entry` apontar para
 * um ficheiro inexistente NÃO descarta o plugin aqui — o host pode servir
 * dists construídos noutro passo; o erro aparece no `import()` do navegador.
 */
export function readClientField(pkg: Record<string, unknown>): ClientField | null {
  const dsh = pkg['dsh']
  if (typeof dsh !== 'object' || dsh === null) return null
  const client = (dsh as Record<string, unknown>)['client']
  if (typeof client !== 'object' || client === null) return null
  return client as ClientField
}

/**
 * Descobre os plugins de UI a partir de uma lista de directórios de pacotes.
 *
 * `roots` são directórios que contêm um `package.json` (tipicamente os
 * `node_modules/@open-harness/*` resolvidos a partir do perfil). Directórios
 * sem `dsh.client` são ignorados em silêncio — a maioria dos pacotes não é
 * plugin de UI.
 */
export function scanClientPlugins(roots: string[]): ScannedClient[] {
  const found: ScannedClient[] = []
  for (const root of roots) {
    const dir = resolve(root)
    const pkg = readManifest(dir)
    if (!pkg) continue
    const field = readClientField(pkg)
    if (!field) continue
    const packageName = typeof pkg['name'] === 'string' ? pkg['name'] : basename(dir)
    const entryRel = field.entry ?? './dist/client.js'
    const entryDir = dirname(entryRel)
    const entryName = basename(entryRel)
    // A raiz de URL é a pasta do `entry`, para imports relativos resolverem.
    const urlDir = entryDir === '.' ? dir : join(dir, entryDir)
    found.push({
      id: field.id ?? derivePluginId(packageName),
      packageName,
      dir: urlDir,
      entry: entryName,
      slots: Array.isArray(field.slots) ? field.slots.filter((s): s is string => typeof s === 'string') : [],
      order: typeof field.order === 'number' ? field.order : DEFAULT_ORDER,
    })
  }
  // Ordem estável: `order`, depois id — dois arranques dão o mesmo manifesto.
  return found.sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id))
}

/**
 * Converte um plugin descoberto no manifesto servido ao navegador.
 *
 * `prefix` é o caminho base (`/plugins/`); a entrada fica em
 * `<prefix><id>/<entry>` e a pasta do `entry` é o resto do caminho.
 */
export function toClientPlugin(scanned: ScannedClient, prefix = '/plugins/'): ClientPlugin {
  const base = prefix.endsWith('/') ? prefix : `${prefix}/`
  return {
    id: scanned.id,
    packageName: scanned.packageName,
    entry: `${base}${scanned.id}/${scanned.entry}`,
    slots: [...scanned.slots],
    order: scanned.order,
  }
}
