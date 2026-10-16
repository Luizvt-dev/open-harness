import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@open-harness/cordis'
import { AGENT_SERVICE, type AgentService } from '@open-harness/dsh-agent'
import { createGateway, createHttpRpc, createMuxHandler, type Gateway } from '@open-harness/dsh-api-gateway'
import { createRemotes } from '@open-harness/dsh-api-remotes'
import { sendJson, serveStatic, WebServer } from '@open-harness/dsh-host-webserver'
import { resolveDshHome } from '@open-harness/home-paths'
import { createServiceHost } from './host.js'
import { readVersion } from './profile.js'

/** Nome do serviço que a linha `webserver` publica. */
export const WEB_SERVER_SERVICE = 'webserver'

/** Endereço por omissão — local, e só local. */
export const DEFAULT_WEB_HOST = '127.0.0.1'

/** Porta por omissão. */
export const DEFAULT_WEB_PORT = 3080

/**
 * Directório `dist` de um pacote do workspace.
 *
 * A entrada `.` resolve para `dist/index.js`, por isso o `dirname` é a pasta
 * de módulos ES que o navegador pode carregar tal como o Node os consome.
 */
function distDirOf(specifier: string): string {
  return dirname(fileURLToPath(import.meta.resolve(specifier)))
}

/**
 * Pacotes servidos em `/client/<pasta>/<ficheiro>`.
 *
 * A UI não tem bundler (nem precisa): carrega os módulos compilados do
 * próprio repositório via import map. `dsh-api-gateway` aponta para a entrada
 * `./browser` — a entrada `.` puxa `node:crypto` e não corre no navegador.
 */
function clientModuleRoots(): Map<string, string> {
  return new Map([
    ['dsh-client-connection', distDirOf('@open-harness/dsh-client-connection')],
    ['dsh-api-gateway', distDirOf('@open-harness/dsh-api-gateway')],
  ])
}

/** Configuração da linha `webserver` (bundle/perfil/overlay). */
export interface WebServerConfig {
  /** Porta TCP; `0` escolhe uma livre. Default 3080. */
  port?: number
  /** Endereço de escuta. Default `127.0.0.1`. */
  host?: string
  /** Token de acesso; se omitido, gera-se um aleatório por arranque. */
  token?: string
  /** Directório estático (a UI). Se não existir, o host serve só a API. */
  publicDir?: string
  /** Intervalo de heartbeat (ms). Default 15 000. */
  heartbeatMs?: number
  /** Observabilidade do servidor. */
  log?: (line: string) => void
}

/** O que a linha `webserver` publica — para a UI/testes inspeccionarem. */
export interface WebServerHandle {
  readonly url: string
  readonly port: number
  readonly host: string
  readonly token: string
  readonly gateway: Gateway
  readonly server: WebServer
}

/**
 * Plugin cordis que sobe o servidor web do host.
 *
 * Compõe as peças da Fase 3 numa só linha declarativa:
 *
 * - `agent` (injetado) → `createServiceHost` → uma sessão por conversa;
 * - `createRemotes` → os controllers (`session`, `job`, `workspace`, …);
 * - `createGateway` → o registry único que o mux WebSocket e o caminho
 *   HTTP/SSE partilham;
 * - `WebServer.listen` → HTTP local com token obrigatório e upgrade por
 *   caminho.
 *
 * A linha declara `requires: ['agent']`, mas o `inject` é o que garante a
 * ordem — o servidor só arranca depois de o agente do perfil existir.
 */
const plugin = {
  inject: [AGENT_SERVICE],
  async apply(ctx: Context, config: WebServerConfig = {}): Promise<void> {
    const agent = ctx.get<AgentService>(AGENT_SERVICE)
    const host = config.host ?? DEFAULT_WEB_HOST
    const port = config.port ?? DEFAULT_WEB_PORT
    const token = config.token ?? randomBytes(16).toString('hex')

    const sessions = createServiceHost(agent, { cwd: agent.session.header.cwd })
    const gateway = createGateway(
      createRemotes({
        host: sessions,
        cwd: agent.session.header.cwd,
        home: agent.config.homeDir ?? resolveDshHome(),
        version: readVersion(),
        readSettings: () => ({
          model: agent.modelRef,
          cwd: agent.session.header.cwd,
          version: readVersion(),
        }),
      }),
    )

    const mux = createMuxHandler(gateway, {
      ...(config.heartbeatMs !== undefined ? { heartbeatMs: config.heartbeatMs } : {}),
    })
    const rpc = createHttpRpc(gateway)

    const staticDir = config.publicDir && existsSync(config.publicDir) ? config.publicDir : undefined
    const server = await WebServer.listen({
      host,
      port,
      token,
      ...(staticDir ? { staticDir } : {}),
      ...(config.log ? { log: config.log } : {}),
    })

    // Os três caminhos do mesmo gateway: unary, SSE e mux WebSocket.
    server.use('/api/remote', rpc.unary)
    server.use('/api/remote/stream', rpc.stream)
    server.upgrade('/api/remote.mux', mux.attach)

    // Módulos ES do cliente para o navegador (`/client/<pacote>/<ficheiro>`).
    // A autenticação já aconteceu no servidor antes de qualquer rota; aqui só
    // se serve o `dist` dos dois pacotes, sem caminhos fora deles.
    const roots = clientModuleRoots()
    server.use('/client/', async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: { code: 'method_not_allowed', message: 'GET only' } })
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://local').pathname
      const rest = pathname.slice('/client/'.length)
      const slash = rest.indexOf('/')
      const pkg = slash > 0 ? rest.slice(0, slash) : ''
      const file = slash > 0 ? rest.slice(slash) : ''
      const root = pkg ? roots.get(pkg) : undefined
      if (!root || !file) {
        sendJson(res, 404, { error: { code: 'not_found', message: `no client module for ${pathname}` } })
        return
      }
      const served = await serveStatic(req, res, file, { root, compressFrom: 1024 })
      if (!served) {
        sendJson(res, 404, { error: { code: 'not_found', message: `no such module: ${pkg}${file}` } })
      }
    })

    // Desligar o servidor quando a fibra morre (shutdown da CLI, HMR, erro).
    ctx.effect(() => () => {
      void server.close()
    })

    const handle: WebServerHandle = {
      url: server.baseUrl,
      port: server.port,
      host,
      token,
      gateway,
      server,
    }
    ctx.set(WEB_SERVER_SERVICE, handle)
  },
}

export const apply = plugin.apply
export default plugin
