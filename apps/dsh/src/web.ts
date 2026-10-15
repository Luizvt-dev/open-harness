import { randomBytes } from 'node:crypto'
import { join, resolve } from 'node:path'
import { Context } from '@open-harness/cordis'
import { bootApp } from '@open-harness/app-boot'
import { LLM_ADAPTER_SERVICE } from '@open-harness/dsh-agent'
import type { LlmAdapter } from '@open-harness/dsh-llm'
import { resolveDshHome } from '@open-harness/home-paths'
import {
  ensureProfile,
  readAgentConfig,
  webBundleDir,
  writeRuntimeOverlay,
  WEB_PROFILE,
  type RuntimeOverrides,
} from './profile.js'
import { DEFAULT_WEB_HOST, DEFAULT_WEB_PORT, WEB_SERVER_SERVICE, type WebServerHandle } from './web-plugin.js'

/** Opções de `dsh web`. */
export interface WebOptions extends RuntimeOverrides {
  /** Porta TCP; `0` escolhe uma livre. Default 3080. */
  port?: number
  /** Endereço de escuta. Default `127.0.0.1`. */
  host?: string
  /** Token de acesso; se omitido, gera-se um por arranque. */
  token?: string
  /** Nome do perfil; por omissão `web`. */
  profile?: string
  /** Home de dados; por omissão `resolveDshHome()`. */
  homeDir?: string
  /** UI estática; por omissão o `public/` do bundle web, se existir. */
  publicDir?: string
  /** Adapter LLM injectado (modo offline / testes). */
  adapter?: LlmAdapter
  /** Cancelamento (SIGINT na CLI). */
  signal?: AbortSignal
  /** Observabilidade. */
  log?: (line: string) => void
}

/** Servidor em execução, pronto a usar e a encerrar. */
export interface WebHandle extends WebServerHandle {
  /** Directório do perfil arrancado. */
  readonly profileDir: string
  /** Nome do perfil arrancado. */
  readonly profile: string
  /** Encerra servidor e boot. Idempotente. */
  shutdown(): Promise<void>
}

/**
 * Sobe o host web sem ficar à espera de nada.
 *
 * 1. materializa/valida o perfil (`web` é gerado pela CLI);
 * 2. escreve o overlay de runtime — herança do agente + porta/endereço/token
 *    da linha `webserver`;
 * 3. cria o `Context` (e injeta um adapter LLM, se houver);
 * 4. `bootApp` aplica as linhas: `agent` → `cli-tools` → `webserver`;
 * 5. devolve o handle publicado pela linha `webserver`.
 *
 * É esta função que os testes usam: sobem um servidor real numa porta livre,
 * falam por WebSocket/HTTP e desligam-no no `finally`.
 */
export async function startWeb(options: WebOptions = {}): Promise<WebHandle> {
  const profile = options.profile ?? WEB_PROFILE
  const home = resolve(options.homeDir ?? resolveDshHome())
  const token = options.token ?? randomBytes(16).toString('hex')

  const { profileDir } = ensureProfile({ homeDir: home, name: profile })
  const base = readAgentConfig(profileDir, home)
  const publicDir = options.publicDir ?? defaultPublicDir()
  const overlay = writeRuntimeOverlay(
    home,
    {
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.system !== undefined ? { system: options.system } : {}),
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      web: {
        port: options.port ?? DEFAULT_WEB_PORT,
        host: options.host ?? DEFAULT_WEB_HOST,
        token,
        ...(publicDir !== undefined ? { publicDir } : {}),
      },
    },
    base,
  )

  const ctx = new Context()
  if (options.adapter) ctx.set(LLM_ADAPTER_SERVICE, options.adapter)

  const boot = await bootApp({
    ctx,
    profileDir,
    homeDir: home,
    overlays: [overlay],
    onRowError: 'strict',
  })

  let closed = false
  const shutdown = async (): Promise<void> => {
    if (closed) return
    closed = true
    await boot.shutdown()
  }

  try {
    const handle = ctx.get<WebServerHandle>(WEB_SERVER_SERVICE)
    return {
      url: handle.url,
      port: handle.port,
      host: handle.host,
      token: handle.token,
      gateway: handle.gateway,
      server: handle.server,
      profileDir,
      profile,
      shutdown,
    }
  } catch (error) {
    await shutdown()
    throw error
  }
}

/**
 * Arranca o host web e fica à espera do cancelamento (Ctrl+C na CLI).
 *
 * Ao desligar, encerra primeiro o servidor e só depois o boot — a ordem
 * inversa deixaria ligações WebSocket penduradas à espera de um shutdown que
 * já tinha passado.
 */
export async function runWeb(options: WebOptions = {}): Promise<void> {
  const handle = await startWeb(options)
  const log = options.log ?? ((line: string) => console.error(line))
  log(`dsh web em ${handle.url}`)
  log(`token    ${handle.token}`)
  log(`perfil   ${handle.profile} (${handle.profileDir})`)
  log('prima Ctrl+C para parar')
  try {
    await waitForAbort(options.signal)
  } finally {
    await handle.shutdown()
  }
}

/** `public/` do bundle web, se a UI já tiver sido escrita. */
function defaultPublicDir(): string {
  return join(webBundleDir(), 'public')
}

/** Espera o sinal abortar; sem sinal, espera para sempre (processo fica vivo). */
function waitForAbort(signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise<void>(() => undefined)
  if (signal.aborted) return Promise.resolve()
  return new Promise<void>((resolvePromise) => {
    signal.addEventListener('abort', () => resolvePromise(), { once: true })
  })
}
