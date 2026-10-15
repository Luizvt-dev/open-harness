import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Home de dados do harness.
 *
 * Decisão deliberada (divergência do plano original, por segurança):
 * - **não** lemos `DSH_HOME` — se o utilizador tiver o DeepSeek Harness real
 *   instalado, partilhar o directório destruiria dados de um dos dois;
 * - usamos `OPEN_HARNESS_HOME` (ou `OHSH_HOME`) como override, com fallback
 *   para `~/.open-harness`.
 */
export const HOME_ENV = 'OPEN_HARNESS_HOME'
export const ALT_HOME_ENV = 'OHSH_HOME'
export const DEFAULT_HOME_DIR = '.open-harness'

export interface HomeOptions {
  env?: NodeJS.ProcessEnv
  homedir?: string
}

/** Resolve o home de dados (sem efeitos secundários — nada é criado em disco). */
export function resolveDshHome(options: HomeOptions = {}): string {
  const env = options.env ?? process.env
  const explicit = env[HOME_ENV] || env[ALT_HOME_ENV]
  if (explicit) return resolve(explicit)
  return join(options.homedir ?? homedir(), DEFAULT_HOME_DIR)
}

/** Junta segmentos ao home: `dshHomePath('sessions', 'abc')`. */
export function dshHomePath(...segments: string[]): string {
  return join(resolveDshHome(), ...segments)
}

/** Ficheiro de patch ao nível do home (última camada antes dos overlays `--patch`). */
export const HOME_PATCH_FILE = 'cordis.patch.yml'

export interface HomePaths {
  home: string
  /** `$HOME/profiles` — um directório por perfil (`desktop`, `web`, …). */
  profiles: string
  /** `$HOME/profiles/<name>` + o seu `cordis.patch.yml`. */
  profile: (name: string) => string
  profilePatch: (name: string) => string
  /** Patch ao nível do home (aplica-se a todos os perfis). */
  homePatch: string
  sessions: string
  storages: string
  attachments: string
  credentials: string
}

export function getHomePaths(options: HomeOptions = {}): HomePaths {
  const home = resolveDshHome(options)
  return {
    home,
    profiles: join(home, 'profiles'),
    profile: (name) => join(home, 'profiles', name),
    profilePatch: (name) => join(home, 'profiles', name, HOME_PATCH_FILE),
    homePatch: join(home, HOME_PATCH_FILE),
    sessions: join(home, 'sessions'),
    storages: join(home, 'storages'),
    attachments: join(home, 'attachments'),
    credentials: join(home, '.credentials.yaml'),
  }
}
