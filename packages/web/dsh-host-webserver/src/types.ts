import type { IncomingMessage, ServerResponse } from 'node:http'

// ---------------------------------------------------------------------------
// Tipos do servidor web local
//
// O dsh observado sobe o app Web em `127.0.0.1:3080` (fallback) e entrega ao
// shell uma URL já autenticada com token. Aqui reproduzimos isso: um servidor
// HTTP só-local, com token obrigatório, estático com SPA fallback e upgrade
// WebSocket para o transporte multiplexado.
// ---------------------------------------------------------------------------

/** Handler de rota API — igual ao do `node:http` (pode ser async). */
export type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

/**
 * Socket WebSocket vista de forma estrutural.
 *
 * O gateway de RPC usa só estes membros, por isso não depende de `ws` — o
 * handshake é da responsabilidade do servidor web, que é quem sabe falar a
 * protocolo WebSocket.
 */
export interface WebSocketLike {
  readyState: number
  send(data: string, cb?: (error?: Error) => void): void
  close(code?: number, reason?: string): void
  on(event: 'message', listener: (data: unknown) => void): unknown
  on(event: 'close', listener: (code: number, reason: Buffer) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
}

/** Constante `OPEN` do protocolo WebSocket (1). */
export const WS_OPEN = 1

/** Anexador de um socket já autenticado, para um dado caminho de upgrade. */
export type UpgradeAttach = (socket: WebSocketLike, req: IncomingMessage) => void

export interface WebServerOptions {
  /** Porta TCP. Default `0` (efêmero) — a CLI usa 3080 como fallback. */
  port?: number
  /** Interface. Default `127.0.0.1` — o servidor é local por omissão. */
  host?: string
  /** Token de acesso obrigatório em todas as rotas. */
  token: string
  /** Directório servido em `/`; com SPA fallback para caminhos sem ficheiro. */
  staticDir?: string
  /** Tamanho mínimo (bytes) para comprimir. Default 1024. */
  compressFrom?: number
  /** Ligar `permessage-deflate` no WebSocket. Default `true`. */
  perMessageDeflate?: boolean
  /** Observabilidade (default: silencioso). */
  log?: (line: string) => void
}

/** Informação devolvida por `GET /api/health`. */
export interface HealthReport {
  ok: true
  /** Nome/versão do host. */
  server: string
  /** Caminhos de API montados. */
  routes: string[]
  /** Caminhos de upgrade montados. */
  upgrades: string[]
  uptimeMs: number
}
