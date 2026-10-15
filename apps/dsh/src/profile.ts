import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stringify } from 'yaml'
import { defaultProfileDir } from '@open-harness/profile-boot'

/** Nome do perfil headless embutido na CLI. */
export const HEADLESS_PROFILE = 'headless'

/**
 * Raiz do pacote da CLI. `dist/profile.js` → um nível acima → raiz, onde
 * vivem `bundles/`. Fora de `dist` (ex.: ao correr a fonte em testes) o
 * `dirname` da raiz `src/` dá a mesma raiz de pacote.
 */
export function cliPackageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..')
}

/** Directório do bundle headless (o `cordis.patch.yml` que compõe o arranque). */
export function headlessBundleDir(): string {
  return join(cliPackageRoot(), 'bundles', 'headless')
}

export interface EnsureProfileOptions {
  /** Home de dados (`--home` ou `resolveDshHome()`). */
  homeDir: string
  /** Nome do perfil; por omissão `headless`. */
  name?: string
  /** Bundle a usar no perfil headless; por omissão o embutido na CLI. */
  bundleDir?: string
}

export interface ProfileHandle {
  /** Directório do perfil, pronto a passar ao `composeProfile`. */
  profileDir: string
  /** O perfil já existia em disco (não foi materializado nesta execução). */
  existed: boolean
}

/**
 * Garante que o perfil existe.
 *
 * - `headless` é **materializado pela CLI**: escreve o manifesto apontando ao
 *   bundle embutido. É idempotente — reescreve sempre o manifesto para que um
 *   upgrade da CLI siga o bundle novo, mas nunca toca noutras camadas.
 * - qualquer outro nome tem de existir previamente (é perfil do utilizador).
 */
export function ensureProfile(options: EnsureProfileOptions): ProfileHandle {
  const name = options.name ?? HEADLESS_PROFILE
  const profileDir = defaultProfileDir(name, options.homeDir)
  const existed = existsSync(profileDir)

  if (name !== HEADLESS_PROFILE) {
    if (!existed) {
      throw new Error(`profile not found: ${profileDir} (only "${HEADLESS_PROFILE}" is materialised by the CLI)`)
    }
    return { profileDir, existed }
  }

  const bundleDir = resolve(options.bundleDir ?? headlessBundleDir())
  if (!existsSync(join(bundleDir, 'cordis.patch.yml'))) {
    throw new Error(`headless bundle not found: ${bundleDir}`)
  }

  mkdirSync(profileDir, { recursive: true })
  writeFileSync(
    join(profileDir, 'package.json'),
    `${JSON.stringify(
      {
        name,
        private: true,
        dsh: { profile: { bundles: [{ path: bundleDir }] } },
      },
      null,
      2,
    )}\n`,
    'utf8',
  )

  return { profileDir, existed }
}

/** Sobrescritas de configuração vindas da linha de comandos. */
export interface RuntimeOverrides {
  model?: string
  system?: string
  cwd?: string
}

/**
 * Escreve o overlay de runtime (`<home>/runtime/overlay.yml`) com as
 * sobrescritas da linha de comandos.
 *
 * Usamos overlay (e não o `cordis.patch.yml` do perfil) porque o overlay é a
 * camada **mais alta** da composição — sobrescreve `config` por inteiro sem
 * mutar ficheiros do utilizador — e porque só declara `config:`: o
 * `requireDir` da linha continua a ser o do bundle que declarou o `plugin`,
 * essencial para o `@open-harness/dsh-agent` resolver no `node_modules` da app.
 *
 * Devolve o caminho do overlay escrito (há sempre `homeDir` a sobrepor, para
 * que `--home` chegue ao serviço do agente).
 */
export function writeRuntimeOverlay(homeDir: string, overrides: RuntimeOverrides): string {
  const config: Record<string, unknown> = { homeDir: resolve(homeDir) }
  if (overrides.model !== undefined) config.model = overrides.model
  if (overrides.system !== undefined) config.system = overrides.system
  if (overrides.cwd !== undefined) config.cwd = resolve(overrides.cwd)

  const doc = stringify({ agent: { config } })
  const target = join(resolve(homeDir), 'runtime', 'overlay.yml')
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(
    target,
    `# Gerado pela CLI \`dsh\` a cada execução (--home/--model/--system/--cwd).\n` +
      `# Camada de overlay: sobrescreve o \`config\` da linha \`agent\` por inteiro.\n${doc}`,
    'utf8',
  )
  return target
}
