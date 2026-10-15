import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  Context,
  InvalidPluginError,
  splitInject,
  type InjectSpec,
  type PluginObject,
} from '@open-harness/cordis'

// ---------------------------------------------------------------------------
// Contrato de entrada (alimentado pelo profile-boot)
// ---------------------------------------------------------------------------

export type SkippedReason = 'disabled' | 'config-only'
export type FailReason = 'resolve' | 'instantiate' | 'apply'

/** Uma linha resolvida do documento de composição. */
export interface PluginEntry {
  /** Chave estável no documento de patch (último-por-id vence aconteceu a montante). */
  id: string
  /** Especificador do módulo (caminho ou nome de pacote); `null` = linha só-de-config. */
  plugin: string | null
  /** Configuração composta — substituída por inteiro, nunca mesclada em fundo. */
  config?: Record<string, unknown>
  enabled?: boolean
  /** Ordenação explícita (default: ordem de inserção no documento). */
  order?: number
  /** Agrupa linhas; com `isolate` cria uma fibra partilhada descartável. */
  group?: string
  isolate?: boolean
  /** Serviços obrigatórios adicionais para a activação (além dos do plugin). */
  requires?: string[]
}

export interface SkippedEntry {
  id: string
  reason: SkippedReason
}

export interface FailedEntry {
  id: string
  reason: FailReason
  error: unknown
}

export interface LoadReport {
  applied: string[]
  skipped: SkippedEntry[]
  failed: FailedEntry[]
}

export interface UpdateReport extends LoadReport {
  /** Configuração quente: `reconfigure` chamado sem reiniciar a fibra. */
  reconfigured: string[]
  /** Linha reiniciada (fibra desfeita e reaplicada). */
  restarted: string[]
  /** Linha removida/desabilitada. */
  removed: string[]
}

export interface LoaderOptions {
  /** Directório base para resolver especificadores relativos/`node_modules`. */
  requireDir?: string
  /** Substituição do carregamento de módulo (testes, plugins remotos, …). */
  importModule?: (specifier: string, requireDir: string) => Promise<unknown>
  /** Notifica linhas saltadas (`disabled`, `config-only`). */
  onSkip?: (entry: SkippedEntry) => void
  /** Notifica linhas falhadas (a entrada também fica em `report.failed`). */
  onFail?: (entry: FailedEntry) => void
}

interface LoadedRow {
  entry: PluginEntry
  /** Definição instanciada (pode expor `reconfigure` para HMR quente). */
  bound: PluginObject
  /** Fibra da linha — dispose dela remove tudo o que a linha criou. */
  rowCtx: Context
  config: Record<string, unknown>
  signature: string
  configFingerprint: string
}

// ---------------------------------------------------------------------------
// Resolução de módulos
// ---------------------------------------------------------------------------

export async function defaultImport(specifier: string, requireDir: string): Promise<unknown> {
  const modulePath = await resolveModulePath(specifier, requireDir)
  return import(pathToFileURL(modulePath).href)
}

export async function resolveModulePath(specifier: string, requireDir: string): Promise<string> {
  if (specifier.startsWith('file:')) return fileURLToPath(specifier)
  if (specifier.startsWith('.') || isAbsolute(specifier)) return resolvePath(requireDir, specifier)

  // 1) resolução CJS (cobre a maioria dos pacotes CJS/dual)
  try {
    const require = createRequire(join(requireDir, 'noop.js'))
    return require.resolve(specifier)
  } catch {
    /* tenta a heurística seguinte */
  }

  // 2) caminhada `node_modules` + `package.json` (pacotes ESM-puro sem condição require)
  const walked = walkNodeModules(specifier, requireDir)
  if (walked) return walked

  throw new Error(`cannot resolve plugin module "${specifier}" from ${requireDir}`)
}

function walkNodeModules(specifier: string, fromDir: string): string | null {
  let dir = resolvePath(fromDir)
  for (;;) {
    const candidate = join(dir, 'node_modules', specifier)
    if (existsSync(join(candidate, 'package.json'))) {
      const entry = packageEntry(candidate)
      if (entry) return entry
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function packageEntry(packageDir: string): string | null {
  let pkg: Record<string, unknown>
  try {
    pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
  const candidates = [
    pickExport(pkg.exports),
    typeof pkg.module === 'string' ? pkg.module : null,
    typeof pkg.main === 'string' ? pkg.main : null,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0)

  for (const candidate of candidates) {
    const direct = join(packageDir, candidate)
    if (existsSync(direct) && !direct.endsWith('/')) return direct
    if (existsSync(`${direct}.js`)) return `${direct}.js`
    for (const index of ['index.js', 'index.mjs', 'index.cjs']) {
      const nested = join(direct, index)
      if (existsSync(nested)) return nested
    }
  }
  for (const index of ['index.js', 'index.mjs', 'index.cjs']) {
    const fallback = join(packageDir, index)
    if (existsSync(fallback)) return fallback
  }
  return null
}

function pickExport(exports: unknown): string | null {
  if (typeof exports === 'string') return exports
  if (!exports || typeof exports !== 'object') return null
  const map = exports as Record<string, unknown>
  if ('.' in map) return pickExport(map['.'])
  for (const condition of ['import', 'module', 'default', 'require']) {
    if (condition in map) {
      const picked = pickExport(map[condition])
      if (picked) return picked
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Instanciação
// ---------------------------------------------------------------------------

function isClass(value: unknown): value is new (...args: any[]) => unknown {
  if (typeof value !== 'function') return false
  return /^class[\s{]/.test(Function.prototype.toString.call(value))
}

function unwrapModule(mod: unknown): unknown {
  if (mod && typeof mod === 'object' && 'default' in mod) {
    const fallback = (mod as { default: unknown }).default
    if (typeof fallback === 'function' || isClass(fallback)) return fallback
    if (fallback && typeof fallback === 'object' && typeof (fallback as PluginObject).apply === 'function') {
      return fallback
    }
  }
  return mod
}

/**
 * Converte o export num `PluginObject` **por linha**:
 * - função → invocada por chamada (sem estado partilhado);
 * - classe → instanciada por linha (precisa de `apply(ctx, config)`);
 * - objeto → clonado em raso (métodos próprios, estado por linha).
 * `reconfigure(config)` (se existir) é o caminho de actualização quente no HMR.
 */
export function instantiatePlugin(specifier: string, raw: unknown): PluginObject {
  const exported = unwrapModule(raw)
  if (isClass(exported)) {
    const instance = new (exported as new () => Record<string, unknown>)()
    if (typeof instance.apply !== 'function') {
      throw new InvalidPluginError(`class "${specifier}" has no apply(ctx, config) method`)
    }
    const apply = instance.apply as (ctx: Context, config: unknown) => void | Promise<void>
    const bound: PluginObject = {
      name: exported.name || undefined,
      inject: instance.inject as InjectSpec | undefined,
      apply: (ctx, config) => apply.call(instance, ctx, config),
    }
    if (typeof instance.reconfigure === 'function') {
      const reconfigure = instance.reconfigure as (config: unknown) => void | Promise<void>
      bound.reconfigure = (config) => reconfigure.call(instance, config)
    }
    return bound
  }
  if (typeof exported === 'function') {
    type FunctionPlugin = ((ctx: Context, config: unknown) => void | Promise<void>) & {
      inject?: InjectSpec
      reconfigure?: (config: unknown) => void | Promise<void>
    }
    const fn = exported as FunctionPlugin
    const bound: PluginObject = {
      name: fn.name || undefined,
      inject: fn.inject,
      apply: (ctx, config) => fn.call(undefined, ctx, config),
    }
    if (typeof fn.reconfigure === 'function') {
      bound.reconfigure = (config) => fn.reconfigure!(config)
    }
    return bound
  }
  if (exported && typeof exported === 'object' && typeof (exported as PluginObject).apply === 'function') {
    // Clone raso por linha, com `apply`/`reconfigure` religados AO PRÓPRIO clone:
    // assim `this` é o mesmo objecto dentro dos dois (estado partilhado entre eles,
    // independente entre linhas).
    const clone = { ...(exported as object) } as PluginObject
    const bound: PluginObject = { ...clone }
    bound.apply = clone.apply.bind(bound)
    if (typeof clone.reconfigure === 'function') bound.reconfigure = clone.reconfigure.bind(bound)
    return bound
  }
  throw new InvalidPluginError(
    `module "${specifier}" does not export a plugin (function, class with apply, or object with apply)`,
  )
}

// ---------------------------------------------------------------------------
// Utilidades de fingerprint
// ---------------------------------------------------------------------------

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`
}

function signatureOf(entry: PluginEntry): string {
  return stableStringify({
    plugin: entry.plugin,
    group: entry.group ?? null,
    isolate: entry.isolate ?? false,
    requires: entry.requires ?? [],
  })
}

function configFingerprintOf(entry: PluginEntry): string {
  return stableStringify({ enabled: entry.enabled ?? true, config: entry.config ?? {} })
}

function mergeInject(base: InjectSpec | undefined, requires: string[] | undefined): InjectSpec | undefined {
  if (!requires || requires.length === 0) return base
  const { required, optional } = splitInject(base)
  const merged = [...new Set([...required, ...requires])]
  return optional.length ? { required: merged, optional } : merged
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export class PluginLoader {
  private readonly ctx: Context
  private readonly options: LoaderOptions
  private readonly requireDir: string
  private readonly importFn: (specifier: string, requireDir: string) => Promise<unknown>
  private readonly exports = new Map<string, unknown>()
  private readonly rows = new Map<string, LoadedRow>()
  private readonly groups = new Map<string, Context>()
  private loaded = false

  constructor(ctx: Context, options: LoaderOptions = {}) {
    this.ctx = ctx
    this.options = options
    this.requireDir = options.requireDir ?? process.cwd()
    this.importFn = options.importModule ?? defaultImport
  }

  /** Linhas vivas (ordem de registo). */
  get entries(): PluginEntry[] {
    return [...this.rows.values()].map((row) => row.entry)
  }

  get groupContexts(): Context[] {
    return [...this.groups.values()]
  }

  /** Aplica o documento de entradas completo. Só pode correr uma vez (depois use `update`). */
  async load(entries: PluginEntry[]): Promise<LoadReport> {
    if (this.loaded) throw new Error('loader already loaded — use update()')
    this.loaded = true
    const report: LoadReport = { applied: [], skipped: [], failed: [] }
    await this.runAll(entries, report)
    await this.sweepGroups()
    return report
  }

  /**
   * Re-aplica um novo documento por diff (HMR):
   * - `reconfigure` quando o plugin o suporta (sem reiniciar a fibra);
   * - reinício da linha quando plugin/grupo/inject mudam;
   * - dispose das linhas que desapareceram ou ficaram `enabled: false`.
   */
  async update(entries: PluginEntry[]): Promise<UpdateReport> {
    const report: UpdateReport = { applied: [], skipped: [], failed: [], reconfigured: [], restarted: [], removed: [] }
    if (!this.loaded) {
      this.loaded = true
      await this.runAll(entries, report)
      await this.sweepGroups()
      return report
    }
    const next = new Map<string, PluginEntry>()
    for (const entry of entries) next.set(entry.id, entry)

    const tasks: Promise<void>[] = []

    for (const id of [...this.rows.keys()]) {
      const entry = next.get(id)
      if (!entry || entry.enabled === false) {
        tasks.push(
          (async () => {
            await this.disposeRow(id)
            report.removed.push(id)
          })(),
        )
      }
    }

    for (const entry of next.values()) {
      const existing = this.rows.get(entry.id)
      if (!existing) {
        tasks.push(this.applyEntry(entry, report))
        continue
      }
      if (signatureOf(entry) === existing.signature && configFingerprintOf(entry) === existing.configFingerprint) {
        continue
      }
      tasks.push(this.replaceRow(entry, existing, report))
    }

    await Promise.all(tasks)
    await this.sweepGroups()
    return report
  }

  /** Desliga todas as linhas (mantém o cache de módulos). */
  async unload(): Promise<void> {
    await Promise.all([...this.rows.keys()].map((id) => this.disposeRow(id)))
    await this.sweepGroups()
  }

  // -------------------------------------------------------------------------
  // Interno
  // -------------------------------------------------------------------------

  private async runAll(entries: PluginEntry[], report: LoadReport): Promise<void> {
    const ordered = entries
      .map((entry, index) => ({ entry, index }))
      .sort((a, b) => (a.entry.order ?? a.index) - (b.entry.order ?? b.index) || a.index - b.index)
    // Chama aplicar em ordem: o contexto de linha/grupo nasce de forma determinística
    // (a resolução de módulo é assíncrona e vem depois).
    await Promise.all(ordered.map(({ entry }) => this.applyEntry(entry, report)))
  }

  private async applyEntry(entry: PluginEntry, report: LoadReport): Promise<void> {
    const id = entry.id
    if (entry.enabled === false) {
      this.skip(report, { id, reason: 'disabled' })
      return
    }
    if (!entry.plugin) {
      this.skip(report, { id, reason: 'config-only' })
      return
    }

    // Contexto da linha ANTES do await → ordem de criação determinística.
    const host = this.hostContext(entry)

    let raw: unknown
    try {
      raw = await this.resolveExport(entry.plugin)
    } catch (error) {
      this.fail(report, { id, reason: 'resolve', error })
      return
    }

    let bound: PluginObject
    try {
      bound = instantiatePlugin(entry.plugin, raw)
    } catch (error) {
      this.fail(report, { id, reason: 'instantiate', error })
      return
    }

    const config = entry.config ?? {}
    const inject = mergeInject(bound.inject, entry.requires)
    try {
      const rowCtx = await host.plugin({ ...bound, inject }, config)
      this.rows.set(id, {
        entry,
        bound,
        rowCtx,
        config,
        signature: signatureOf(entry),
        configFingerprint: configFingerprintOf(entry),
      })
      report.applied.push(id)
    } catch (error) {
      this.fail(report, { id, reason: 'apply', error })
    }
  }

  private async replaceRow(entry: PluginEntry, existing: LoadedRow, report: UpdateReport): Promise<void> {
    const signatureChanged = signatureOf(entry) !== existing.signature
    const configChanged = configFingerprintOf(entry) !== existing.configFingerprint

    if (entry.enabled === false || !entry.plugin) {
      await this.disposeRow(entry.id)
      report.removed.push(entry.id)
      await this.applyEntry(entry, report)
      return
    }

    if (!signatureChanged && configChanged && existing.bound.reconfigure) {
      const config = entry.config ?? {}
      await existing.bound.reconfigure(config)
      existing.entry = entry
      existing.config = config
      existing.configFingerprint = configFingerprintOf(entry)
      report.reconfigured.push(entry.id)
      return
    }

    // reinício da linha (mudou estrutura, ou sem caminho de reconfiguração quente)
    await this.disposeRow(entry.id)
    await this.applyEntry(entry, report)
    report.restarted.push(entry.id)
  }

  private async resolveExport(specifier: string): Promise<unknown> {
    const cached = this.exports.get(specifier)
    if (cached !== undefined) return cached
    const mod = await this.importFn(specifier, this.requireDir)
    this.exports.set(specifier, mod)
    return mod
  }

  private hostContext(entry: PluginEntry): Context {
    if (!entry.group || !entry.isolate) return this.ctx
    let group = this.groups.get(entry.group)
    if (!group) {
      group = this.ctx.fork(`group:${entry.group}`)
      this.groups.set(entry.group, group)
    }
    return group
  }

  private async disposeRow(id: string): Promise<void> {
    const row = this.rows.get(id)
    if (!row) return
    this.rows.delete(id)
    await row.rowCtx.dispose()
  }

  /** Grupos sem filhos não têm razão de ser (evita fibras órfãs após updates). */
  private async sweepGroups(): Promise<void> {
    for (const [name, group] of [...this.groups]) {
      if (group.children.length === 0) {
        this.groups.delete(name)
        await group.dispose()
      }
    }
  }

  private skip(report: LoadReport, entry: SkippedEntry): void {
    report.skipped.push(entry)
    this.options.onSkip?.(entry)
  }

  private fail(report: LoadReport, entry: FailedEntry): void {
    report.failed.push(entry)
    this.options.onFail?.(entry)
  }
}

/** Loader funcional curto (sem estado) para casos simples. */
export async function loadEntries(ctx: Context, entries: PluginEntry[], options?: LoaderOptions): Promise<LoadReport> {
  return new PluginLoader(ctx, options).load(entries)
}
