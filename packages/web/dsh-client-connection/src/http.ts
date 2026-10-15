import { PROTOCOL_VERSION, RemoteError } from '@open-harness/dsh-api-gateway'
import type { ClientOptions, ConnectionState, RemoteClient } from './types.js'

/**
 * Cliente pelo caminho HTTP/SSE.
 *
 * `POST /api/remote` resolve chamadas unary; `POST /api/remote/stream` devolve
 * Server-Sent Events (`open`, `data`…, `end` ou `error`). É o caminho de
 * recurso para ambientes sem WebSocket — e o mais fácil de usar a partir de
 * scripts.
 *
 * Não tem uplink nem heartbeat: sem socket aberto não há canal persistente. A
 * "reconexão" limita-se a refazer o pedido, que é exactamente o que um
 * cliente HTTP deve fazer.
 */
export class HttpClient implements RemoteClient {
  private readonly base: string
  private readonly token: string
  private readonly fetchImpl: typeof fetch

  constructor(options: ClientOptions) {
    this.base = options.url.replace(/\/+$/, '')
    this.token = options.token
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  get state(): ConnectionState {
    // Cada pedido é autónomo: nunca há ligação pendurada a reportar.
    return 'open'
  }

  get generation(): number {
    return 1
  }

  async call<T = unknown>(method: string, params?: unknown): Promise<T> {
    const response = await this.request('/api/remote', method, params)
    const body = (await response.json()) as { result?: unknown; error?: { code: string; message: string; data?: unknown } }
    if (body.error) throw RemoteError.fromShape(body.error)
    return body.result as T
  }

  async *stream<T = unknown>(method: string, params?: unknown): AsyncGenerator<T> {
    const response = await this.request('/api/remote/stream', method, params, {
      accept: 'text/event-stream',
    })
    if (!response.ok || !response.body) {
      throw new RemoteError('unavailable', `stream request failed (${response.status})`)
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) return
        buffer += decoder.decode(value, { stream: true })

        // Um evento SSE termina em linha em branco; os campos são
        // `event: <nome>` e `data: <json>`.
        let cut = buffer.indexOf('\n\n')
        while (cut !== -1) {
          const block = buffer.slice(0, cut)
          buffer = buffer.slice(cut + 2)
          const event = /^event: (.*)$/m.exec(block)?.[1]?.trim() ?? 'message'
          const data = /^data: (.*)$/m.exec(block)?.[1]
          if (data !== undefined) {
            const parsed: unknown = JSON.parse(data)
            if (event === 'error') throw RemoteError.fromShape(parsed as { code: string; message: string })
            if (event === 'end') return
            if (event === 'data') yield parsed as T
          }
          cut = buffer.indexOf('\n\n')
        }
      }
    } finally {
      // `break` a meio do ciclo: fecha a ligação em vez de deixar o servidor
      // a enviar para um leitor que ninguém consome.
      void reader.cancel().catch(() => undefined)
    }
  }

  /** O caminho HTTP não tem uplink — recusa em vez de engolir. */
  send(channel: string, payload?: unknown): void {
    void channel
    void payload
    throw new RemoteError('unavailable', 'uplink requires the WebSocket transport')
  }

  /** O caminho HTTP não tem downlink — devolve um unsubscribe inócuo. */
  on(channel: string, listener: (payload: unknown) => void): () => void {
    void channel
    void listener
    return () => undefined
  }

  /** Não há ligação a esperar: o pedido é que decide. */
  async whenOpen(): Promise<void> {
    return undefined
  }

  close(): void {
    // Nada pendurado para fechar.
  }

  private async request(
    path: string,
    method: string,
    params: unknown,
    extra: Record<string, string> = {},
  ): Promise<Response> {
    let response: Response
    try {
      response = await this.fetchImpl(`${this.base}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.token}`,
          ...extra,
        },
        body: JSON.stringify({ v: PROTOCOL_VERSION, method, params: params ?? null }),
      })
    } catch (error) {
      throw new RemoteError('unavailable', `request failed: ${(error as Error).message}`)
    }
    if (response.status === 401) {
      throw new RemoteError('unauthorized', 'missing or invalid token')
    }
    return response
  }
}
