import { Context } from '@open-harness/cordis'
import {
  PluginLoader,
  defaultImport,
  type FailedEntry,
  type LoadReport,
  type SkippedEntry,
  type UpdateReport,
} from '@open-harness/cordis-plugin-loader'
import {
  composeProfile,
  type ComposedProfile,
  type ComposeOptions,
} from '@open-harness/profile-boot'

// ---------------------------------------------------------------------------
// Erros
// ---------------------------------------------------------------------------

/** Falha de arranque com o relatório completo agarrado ao erro (strict). */
export class BootError extends Error {
  constructor(
    message: string,
    readonly failed: FailedEntry[],
  ) {
    super(message)
    this.name = 'BootError'
  }
}

// ---------------------------------------------------------------------------
// Opções e resultado
// ---------------------------------------------------------------------------

export interface BootOptions extends ComposeOptions {
  /** Contexto raiz; por omissão cria um novo. */
  ctx?: Context
  /** Política para linhas falhadas (`resolve`/`instantiate`/`apply`). Default `strict`. */
  onRowError?: 'strict' | 'lenient'
  /** Directório de recurso para especificadores sem `requireDir` próprio. */
  requireDir?: string
  /** Substituição do carregamento de módulo (testes, plugins remotos, …). */
  importModule?: (specifier: string, requireDir: string) => Promise<unknown>
  /** Notifica linhas saltadas (`disabled`, `config-only`). */
  onSkipRow?: (entry: SkippedEntry) => void
  /** Notifica linhas falhadas (mesmo em `strict`, antes de lançar). */
  onFailRow?: (entry: FailedEntry) => void
}

export interface AppBoot {
  ctx: Context
  loader: PluginLoader
  /** Última composição (actualizada por `reload`). */
  composition: ComposedProfile
  /** Relatório do `load` inicial. */
  report: LoadReport
  /** Recompõe o perfil (ficheiros relidos) e aplica por diff — caminho do HMR. */
  reload: () => Promise<UpdateReport>
  /** Descarrega todas as linhas (dispose). */
  shutdown: () => Promise<void>
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

/**
 * Arranque da aplicação (Fase 1):
 * 1. compõe o perfil (`bundles → perfil → home → overlays`);
 * 2. carrega as linhas no `PluginLoader`, cada uma resolvida a partir do
 *    `requireDir` do bundle que a declarou (layout pnpm-friendly);
 * 3. aplica a política de erros e devolve o conjunto pronto para HMR.
 */
export async function bootApp(options: BootOptions): Promise<AppBoot> {
  const {
    ctx = new Context(),
    onRowError = 'strict',
    requireDir,
    importModule,
    onSkipRow,
    onFailRow,
    ...compose
  } = options

  const composition = composeProfile(compose)

  // `requireDir` por linha: o loader resolve tudo a partir de um directório só,
  // por isso mapeamos especificador → directório do bundle que o declarou.
  const specifierDirs = new Map<string, string>()
  for (const row of composition.rows) {
    if (row.plugin && !specifierDirs.has(row.plugin)) specifierDirs.set(row.plugin, row.requireDir)
  }

  const loader = new PluginLoader(ctx, {
    requireDir: requireDir ?? compose.profileDir,
    importModule:
      importModule ??
      ((specifier, fallback) => defaultImport(specifier, specifierDirs.get(specifier) ?? fallback)),
    ...(onSkipRow ? { onSkip: onSkipRow } : {}),
    ...(onFailRow ? { onFail: onFailRow } : {}),
  })

  const report = await loader.load(composition.rows)
  checkReport(report, onRowError)

  const boot: AppBoot = {
    ctx,
    loader,
    composition,
    report,
    async reload() {
      // Recompor do zero (ficheiros relidos do disco) e aplicar por diff.
      // `PluginLoader.update` decide reconfigure vs reinício por linha.
      const fresh = composeProfile(compose)
      const update = await loader.update(fresh.rows)
      boot.composition = fresh
      checkReport(update, onRowError)
      return update
    },
    async shutdown() {
      await loader.unload()
    },
  }
  return boot
}

function checkReport(report: LoadReport, policy: 'strict' | 'lenient'): void {
  if (policy === 'strict' && report.failed.length) {
    const detail = report.failed
      .map((entry) => `${entry.id} (${entry.reason}: ${describeError(entry.error)})`)
      .join('; ')
    throw new BootError(`boot failed: ${detail}`, report.failed)
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
