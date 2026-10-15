import type { RemoteErrorShape } from './errors.js'

// ---------------------------------------------------------------------------
// Protocolo de transporte (v1)
//
// Molduras JSON num único WebSocket, à maneira do Typert Remote do dsh: o
// mesmo canal transporta chamadas unary, streams multiplexados, heartbeat e
// uplink (eventos do cliente para o host). O id da chamada é o que multiplexa
// tudo no mesmo socket.
// ---------------------------------------------------------------------------

export const PROTOCOL_VERSION = 1

/** Moldura que vem do cliente. */
export type ClientFrame =
  | { v: number; kind: 'call'; id: string; method: string; params?: unknown }
  | { v: number; kind: 'cancel'; id: string }
  /** Uplink: evento do cliente para o host (logs, presença, telemetria). */
  | { v: number; kind: 'event'; channel: string; payload?: unknown }
  | { v: number; kind: 'pong'; t: number }

/** Moldura que sai do host. */
export type ServerFrame =
  | { v: number; kind: 'welcome'; heartbeatMs: number; serverTime: number; methods: string[] }
  | { v: number; kind: 'result'; id: string; result: unknown }
  | { v: number; kind: 'error'; id: string; error: RemoteErrorShape }
  | { v: number; kind: 'data'; id: string; data: unknown }
  | { v: number; kind: 'end'; id: string }
  | { v: number; kind: 'ping'; t: number }
  | { v: number; kind: 'up'; channel: string; payload: unknown }

/**
 * Socket WebSocket vista de forma estrutural — o mesmo contrato do
 * `WebSocketLike` do `dsh-host-webserver`, repetido aqui para o gateway não
 * depender do servidor (é protocolo puro, sem dependências).
 */
export interface GatewaySocket {
  readyState: number
  send(data: string, cb?: (error?: Error) => void): void
  close(code?: number, reason?: string): void
  on(event: 'message', listener: (data: unknown) => void): unknown
  on(event: 'close', listener: (code: number, reason: Buffer) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
}

/** Referência que o handler tem à ligação (para empurrar eventos). */
export interface UplinkChannel {
  /** Id da ligação (estável enquanto o socket vive). */
  readonly id: string
  /** Envia um evento do host para o cliente (downlink). */
  send(channel: string, payload: unknown): void
}

/** Contexto entregue a cada chamada. */
export interface CallContext {
  method: string
  /** Abortado quando o cliente cancela ou a ligação cai. */
  signal: AbortSignal
  /** Canal downlink desta ligação. */
  connection: UplinkChannel
}

/** Método unary: um pedido, uma resposta. */
export interface UnaryMethodSpec<P = never, R = unknown> {
  kind?: 'unary'
  handler(params: P, ctx: CallContext): Promise<R> | R
}

/** Método de stream: um pedido, N molduras de dados, um fim. */
export interface StreamMethodSpec<P = never, D = unknown> {
  kind: 'stream'
  handler(params: P, ctx: CallContext): AsyncIterable<D>
}

/** Especificação heterogénea guardada no registry. */
export type MethodSpec = UnaryMethodSpec | StreamMethodSpec

/** Conjunto de métodos de um remote, com namespace opcional. */
export interface RemoteSpec {
  /** Prefixo dos nomes (`session` → `session.create`). */
  namespace?: string
  methods: Record<string, MethodSpec>
}
