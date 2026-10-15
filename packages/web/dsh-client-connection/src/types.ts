// ---------------------------------------------------------------------------
// Tipos do cliente do navegador
//
// Este pacote tem de correr dentro de um browser, por isso não usa nenhum
// builtin do Node: só os globals `WebSocket` e `fetch`, que existem dos dois
// lados. Os injectáveis (`WebSocketImpl`, `fetchImpl`) são para testes e para
// ambientes que queiram outro transporte.
// ---------------------------------------------------------------------------

export type ConnectionState = 'connecting' | 'open' | 'closed'

export interface ReconnectOptions {
  /** Delay inicial (ms). Default 250. */
  baseDelayMs?: number
  /** Backoff multiplicativo. Default 2. */
  factor?: number
  /** Delay máximo (ms). Default 10 000. */
  maxDelayMs?: number
  /** Tentativas antes de desistir. Default: infinitas. */
  maxAttempts?: number
}

export interface ClientOptions {
  /** URL base do host, ex.: `http://127.0.0.1:3080`. */
  url: string
  /** Token de acesso (vai na query do WebSocket e no header do fetch). */
  token: string
  /**
   * Transporte. Default `mux` — um único WebSocket multiplexado.
   *
   * `http` usa `POST /api/remote` (unary) e `POST /api/remote/stream` (SSE),
   * para ambientes sem WebSocket.
   */
  transport?: 'mux' | 'http'
  /** Reconectar após queda. Default `true`. */
  reconnect?: boolean | ReconnectOptions
  /** Responder aos `ping` do host. Default `true`. */
  heartbeat?: boolean
  /** Observabilidade (só para debug — nunca dados do utilizador). */
  onLog?(line: string): void
  /** `WebSocket` injectável (testes, ou ambientes sem global). */
  WebSocketImpl?: typeof WebSocket
  /** `fetch` injectável. */
  fetchImpl?: typeof fetch
  /** Jitter de backoff injectável, para testes determinísticos. */
  random?: () => number
}

/** Cliente pronto a usar. */
export interface RemoteClient {
  readonly state: ConnectionState
  /** Nº de ligações feitas — cresce a cada reconexão. */
  readonly generation: number
  /** Chamada unary. Falha com `unavailable` se a ligação se perder. */
  call<T = unknown>(method: string, params?: unknown): Promise<T>
  /** Chamada de stream: `data`… `end`, cancelável ao sair do ciclo. */
  stream<T = unknown>(method: string, params?: unknown): AsyncGenerator<T>
  /** Uplink: evento do cliente para o host. Só no transporte mux. */
  send(channel: string, payload?: unknown): void
  /** Subscreve um canal de downlink; devolve o unsubscribe. */
  on(channel: string, listener: (payload: unknown) => void): () => void
  /** Espera até estar aberto (ou falha por timeout/fecho). */
  whenOpen(timeoutMs?: number): Promise<void>
  /** Fecha de vez, sem reconectar. */
  close(): void
}
