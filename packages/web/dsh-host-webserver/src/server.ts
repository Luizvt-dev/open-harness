import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer } from 'ws'
import { isAuthorized } from './auth.js'
import { serveStatic } from './static.js'
import type {
  HealthReport,
  RequestHandler,
  UpgradeAttach,
  WebServerOptions,
  WebSocketLike,
} from './types.js'

const SERVER_NAME = 'open-harness-web/0.1'

/** Headers de segurança aplicados a todas as respostas. */
const BASE_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
}

/** Escreve uma resposta JSON com headers por omissão. */
export function sendJson(
  res: ServerResponse,
  status: number,
  value: unknown,
  extra: Record<string, string> = {},
): void {
  const body = Buffer.from(JSON.stringify(value))
  res.writeHead(status, {
    ...BASE_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
    ...extra,
  })
  res.end(body)
}

/**
 * Caminho do pedido **sem normalizar**.
 *
 * `new URL()` colapsa segmentos `..` (`/a/../b` → `/b`), o que esconde
 * tentativas de path traversal do scanner do servidor. Guardamos o caminho tal
 * como o cliente o enviou e deixamos o resolvedor do estático recusá-lo.
 */
function rawPathname(req: IncomingMessage): string {
  const url = req.url ?? '/'
  const cut = url.indexOf('?')
  const path = cut === -1 ? url : url.slice(0, cut)
  return path || '/'
}

/** Lê o corpo do pedido como texto (com teto de tamanho). */
export async function readBody(req: IncomingMessage, limitBytes = 4 * 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk as Buffer)
    size += buffer.length
    if (size > limitBytes) throw new Error(`request body too large (> ${limitBytes} bytes)`)
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Servidor web local do host.
 *
 * Sobe em `127.0.0.1` por omissão, exige token em todas as rotas (header
 * `Authorization: Bearer` ou `?access_token=`), serve estático com SPA
 * fallback e encaminha upgrades WebSocket para os caminhos registados — é por
 * aí que entra o transporte multiplexado do RPC.
 */
export class WebServer {
  readonly server: Server
  readonly token: string
  readonly host: string

  private readonly wss: WebSocketServer
  private readonly staticDir: string | undefined
  private readonly compressFrom: number
  private readonly log: (line: string) => void
  private readonly startedAt = Date.now()
  private readonly routes = new Map<string, RequestHandler>()
  private readonly upgrades = new Map<string, UpgradeAttach>()
  private boundPort = 0
  private closed = false

  constructor(options: WebServerOptions) {
    if (!options.token) throw new Error('WebServer: token is required')
    this.token = options.token
    this.host = options.host ?? '127.0.0.1'
    this.staticDir = options.staticDir
    this.compressFrom = options.compressFrom ?? 1024
    this.log = options.log ?? (() => undefined)
    this.wss = new WebSocketServer({
      noServer: true,
      perMessageDeflate: options.perMessageDeflate ?? true,
    })
    this.server = createServer((req, res) => {
      void this.handleRequest(req, res)
    })
    this.server.on('upgrade', (req, socket, head) => {
      this.handleUpgrade(req, socket as Duplex, head)
    })
  }

  /** Cria, escuta e devolve o servidor pronto. */
  static async listen(options: WebServerOptions): Promise<WebServer> {
    const server = new WebServer(options)
    await server.listen(options.port ?? 0)
    return server
  }

  /** Porta efectivamente atribuída (útil com `port: 0`). */
  get port(): number {
    return this.boundPort
  }

  /** URL base já autenticada — a que se abre no navegador. */
  get url(): string {
    return `http://${this.host}:${this.boundPort}/?access_token=${encodeURIComponent(this.token)}`
  }

  /** URL base sem credenciais (para clientes que enviam o header). */
  get baseUrl(): string {
    return `http://${this.host}:${this.boundPort}`
  }

  /** Monta um handler para todos os pedidos com aquele prefixo. */
  use(path: string, handler: RequestHandler): this {
    this.routes.set(path, handler)
    return this
  }

  /** Monta um anexador de WebSocket para upgrades naquele caminho. */
  upgrade(path: string, attach: UpgradeAttach): this {
    this.upgrades.set(path, attach)
    return this
  }

  private listenPromise(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error): void => {
        this.server.off('listening', onListening)
        reject(error)
      }
      const onListening = (): void => {
        this.server.off('error', onError)
        resolve()
      }
      this.server.once('error', onError)
      this.server.once('listening', onListening)
      this.server.listen(port, this.host)
    })
  }

  async listen(port = 0): Promise<void> {
    await this.listenPromise(port)
    const address = this.server.address()
    this.boundPort = typeof address === 'object' && address ? address.port : port
    this.log(`webserver listening on ${this.baseUrl}`)
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!isAuthorized(req, this.token)) {
        sendJson(
          res,
          401,
          { error: { code: 'unauthorized', message: 'missing or invalid token' } },
          { 'www-authenticate': 'Bearer' },
        )
        return
      }

      const path = rawPathname(req)

      const route = this.matchRoute(path)
      if (route) {
        await route.handler(req, res)
        return
      }

      if (req.method === 'GET' || req.method === 'HEAD') {
        // Prontidão sempre disponível, com ou sem estático montado.
        if (path === '/api/health') {
          sendJson(res, 200, this.health())
          return
        }
        if (this.staticDir) {
          const served = await serveStatic(req, res, path, {
            root: this.staticDir,
            compressFrom: this.compressFrom,
          })
          if (served) return
          // SPA fallback: rotas de UI que não são ficheiros servem o index.
          if (!path.startsWith('/api/')) {
            await serveStatic(req, res, '/index.html', {
              root: this.staticDir,
              compressFrom: this.compressFrom,
            })
            return
          }
        }
      }

      sendJson(res, 404, { error: { code: 'not_found', message: `no route for ${path}` } })
    } catch (error) {
      this.log(`request error: ${(error as Error).message}`)
      if (!res.headersSent) {
        sendJson(res, 500, {
          error: { code: 'internal', message: (error as Error).message },
        })
      } else {
        res.end()
      }
    }
  }

  /** Rota com o prefixo mais específico (ordem de importância). */
  private matchRoute(path: string): { handler: RequestHandler } | null {
    let best: { path: string; handler: RequestHandler } | null = null
    for (const [prefix, handler] of this.routes) {
      if (path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)) {
        if (!best || prefix.length > best.path.length) best = { path: prefix, handler }
      }
    }
    return best
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const path = rawPathname(req)
    const attach = this.upgrades.get(path)
    if (!attach) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    if (!isAuthorized(req, this.token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      attach(ws as unknown as WebSocketLike, req)
    })
  }

  /** Relatório de prontidão (`/api/health`). */
  health(): HealthReport {
    return {
      ok: true,
      server: SERVER_NAME,
      routes: [...this.routes.keys()].sort(),
      upgrades: [...this.upgrades.keys()].sort(),
      uptimeMs: Date.now() - this.startedAt,
    }
  }

  /** Fecha servidor e ligações abertas. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const client of this.wss.clients) client.terminate()
    await new Promise<void>((resolve) => this.wss.close(() => resolve()))
    await new Promise<void>((resolve) => {
      this.server.closeAllConnections()
      this.server.close(() => resolve())
    })
  }
}
