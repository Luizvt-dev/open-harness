import { PROTOCOL_VERSION, RemoteError, type ClientFrame, type ServerFrame } from '@open-harness/dsh-api-gateway'
import type { ClientOptions, ConnectionState, ReconnectOptions, RemoteClient } from './types.js'

/** WebSocket aberto. */
const WS_OPEN = 1

/** O que fazer com a resposta de uma chamada pendente. */
interface Pending {
  /** Geração da ligação que originou a chamada. */
  generation: number
  /** Unary. */
  resolve?(value: unknown): void
  reject?(error: RemoteError): void
  /** Stream. */
  data?(value: unknown): void
  end?(): void
  error?(error: RemoteError): void
}

interface Waiter {
  resolve(): void
  reject(error: RemoteError): void
  timer: ReturnType<typeof setTimeout>
}

const DEFAULT_RECONNECT: Required<ReconnectOptions> = {
  baseDelayMs: 250,
  factor: 2,
  maxDelayMs: 10_000,
  maxAttempts: Number.POSITIVE_INFINITY,
}

/**
 * Cliente multiplexado sobre um único WebSocket.
 *
 * Fala o mesmo protocolo do host: chamadas unary e streams identificados por
 * `id`, heartbeat (`ping` → `pong`), uplink e downlink por canal. Quando a
 * ligação cai, as chamadas pendentes falham com `unavailable` e a reconexão
 * faz-se com backoff exponencial e *geração* nova — respostas de ligações
 * antigas nunca chegam a callbacks da actual.
 */
export class MuxClient implements RemoteClient {
  private readonly url: string
  private readonly token: string
  private readonly WebSocketImpl: typeof WebSocket
  private readonly onLog: (line: string) => void
  private readonly answerPings: boolean
  private readonly reconnect: Required<ReconnectOptions> | null
  private readonly random: () => number

  private socket: WebSocket | undefined
  private currentState: ConnectionState = 'connecting'
  private currentGeneration = 0
  private counter = 0
  private attempts = 0
  private closedByUser = false
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined

  private readonly pending = new Map<string, Pending>()
  private readonly channels = new Map<string, Set<(payload: unknown) => void>>()
  private readonly waiters: Waiter[] = []

  constructor(options: ClientOptions) {
    if (!options.WebSocketImpl && typeof WebSocket === 'undefined') {
      throw new Error('MuxClient: no global WebSocket; pass WebSocketImpl')
    }
    this.url = options.url
    this.token = options.token
    this.WebSocketImpl = options.WebSocketImpl ?? WebSocket
    this.onLog = options.onLog ?? (() => undefined)
    this.answerPings = options.heartbeat ?? true
    this.random = options.random ?? Math.random
    this.reconnect =
      options.reconnect === false
        ? null
        : { ...DEFAULT_RECONNECT, ...(typeof options.reconnect === 'object' ? options.reconnect : {}) }
    this.connect()
  }

  get state(): ConnectionState {
    return this.currentState
  }

  get generation(): number {
    return this.currentGeneration
  }

  async call<T = unknown>(method: string, params?: unknown): Promise<T> {
    await this.whenOpen()
    const id = this.nextId()
    return await new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        generation: this.currentGeneration,
        resolve: resolve as (value: unknown) => void,
        reject,
      })
      this.sendFrame({ v: PROTOCOL_VERSION, kind: 'call', id, method, params: params ?? null })
    })
  }

  async *stream<T = unknown>(method: string, params?: unknown): AsyncGenerator<T> {
    await this.whenOpen()
    const id = this.nextId()
    const buffer: T[] = []
    let ended = false
    let failure: RemoteError | undefined
    let wake: (() => void) | undefined
    const pump = (): void => {
      const resume = wake
      wake = undefined
      resume?.()
    }

    this.pending.set(id, {
      generation: this.currentGeneration,
      data: (value) => {
        buffer.push(value as T)
        pump()
      },
      end: () => {
        ended = true
        pump()
      },
      error: (error) => {
        failure = error
        ended = true
        pump()
      },
    })

    try {
      this.sendFrame({ v: PROTOCOL_VERSION, kind: 'call', id, method, params: params ?? null })
      while (true) {
        while (buffer.length > 0) yield buffer.shift() as T
        if (failure) throw failure
        if (ended) return
        await new Promise<void>((resolve) => {
          wake = resolve
        })
      }
    } finally {
      this.pending.delete(id)
      // O consumidor desistiu (break/return) a meio: avisa o host para não
      // continuar a trabalhar para ninguém.
      if (!ended && this.socket?.readyState === WS_OPEN) {
        this.socket.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'cancel', id }))
      }
    }
  }

  send(channel: string, payload?: unknown): void {
    this.sendFrame({ v: PROTOCOL_VERSION, kind: 'event', channel, payload: payload ?? null })
  }

  on(channel: string, listener: (payload: unknown) => void): () => void {
    const set = this.channels.get(channel) ?? new Set<(payload: unknown) => void>()
    set.add(listener)
    this.channels.set(channel, set)
    return () => {
      set.delete(listener)
    }
  }

  whenOpen(timeoutMs = 10_000): Promise<void> {
    if (this.currentState === 'open') return Promise.resolve()
    if (this.closedByUser) return Promise.reject(new RemoteError('unavailable', 'client is closed'))
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          reject(new RemoteError('unavailable', 'timed out waiting for the connection'))
        }, timeoutMs),
      }
      this.waiters.push(waiter)
    })
  }

  close(): void {
    this.closedByUser = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    this.socket?.close(1000, 'client closed')
    this.socket = undefined
    this.currentState = 'closed'
    const error = new RemoteError('unavailable', 'client closed')
    this.failAll(error)
    this.rejectWaiters(error)
  }

  // -------------------------------------------------------------------------
  // Ligação
  // -------------------------------------------------------------------------

  private connect(): void {
    if (this.closedByUser) return
    this.currentState = 'connecting'
    const base = this.url.replace(/\/+$/, '').replace(/^http/, 'ws')
    const socket = new this.WebSocketImpl(`${base}/api/remote.mux?access_token=${encodeURIComponent(this.token)}`)
    this.socket = socket

    socket.onopen = (): void => {
      if (socket !== this.socket) return
      this.currentState = 'open'
      this.currentGeneration++
      this.attempts = 0
      this.onLog(`client: connected (generation ${this.currentGeneration})`)
      this.resolveWaiters()
    }
    socket.onmessage = (event: MessageEvent): void => {
      if (socket === this.socket) this.handleMessage(String(event.data))
    }
    // O `onclose` é quem limpa — o `onerror` vem sempre seguido dele.
    socket.onerror = (): undefined => undefined
    socket.onclose = (event: CloseEvent): void => {
      if (socket !== this.socket) return
      this.socket = undefined
      this.currentState = 'closed'
      this.onLog(`client: connection lost (${event.code})`)
      const error = new RemoteError('unavailable', `connection closed (${event.code})`)
      this.failAll(error)
      this.rejectWaiters(error)
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    if (!this.reconnect || this.closedByUser) return
    if (this.attempts >= this.reconnect.maxAttempts) {
      this.onLog(`client: gave up after ${this.attempts} attempts`)
      return
    }
    const delay = this.delayFor(this.attempts)
    this.attempts++
    this.onLog(`client: reconnecting in ${delay}ms (attempt ${this.attempts})`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.connect()
    }, delay)
  }

  /** Backoff exponencial com jitter de ±25% (evita reconectar em sincronia). */
  private delayFor(attempt: number): number {
    const raw = this.reconnect!.baseDelayMs * this.reconnect!.factor ** attempt
    const capped = Math.min(raw, this.reconnect!.maxDelayMs)
    return Math.round(capped * (0.75 + this.random() * 0.5))
  }

  // -------------------------------------------------------------------------
  // Protocolo
  // -------------------------------------------------------------------------

  private sendFrame(frame: ClientFrame): void {
    if (this.socket?.readyState !== WS_OPEN) {
      throw new RemoteError('unavailable', 'connection is not open')
    }
    this.socket.send(JSON.stringify(frame))
  }

  private nextId(): string {
    return `c${this.currentGeneration}_${++this.counter}`
  }

  /** Retira uma chamada pendente, ignorando respostas de gerações antigas. */
  private take(id: string): Pending | undefined {
    const pending = this.pending.get(id)
    if (!pending) return undefined
    this.pending.delete(id)
    if (pending.generation !== this.currentGeneration) return undefined
    return pending
  }

  private handleMessage(raw: string): void {
    let frame: ServerFrame
    try {
      frame = JSON.parse(raw) as ServerFrame
    } catch {
      return
    }
    if (!frame || typeof frame !== 'object') return

    switch (frame.kind) {
      case 'welcome':
        return
      case 'ping':
        if (this.answerPings) {
          this.sendFrame({ v: PROTOCOL_VERSION, kind: 'pong', t: frame.t })
        }
        return
      case 'result': {
        this.take(frame.id)?.resolve?.(frame.result)
        return
      }
      case 'data': {
        this.pending.get(frame.id)?.data?.(frame.data)
        return
      }
      case 'end': {
        this.take(frame.id)?.end?.()
        return
      }
      case 'error': {
        const pending = this.take(frame.id)
        const error = RemoteError.fromShape(frame.error)
        if (pending?.error) pending.error(error)
        else pending?.reject?.(error)
        return
      }
      case 'up': {
        for (const listener of this.channels.get(frame.channel) ?? []) listener(frame.payload)
        return
      }
      default:
        this.onLog(`client: ignoring unknown frame kind`)
    }
  }

  private failAll(error: RemoteError): void {
    for (const [, pending] of this.pending) {
      if (pending.error) pending.error(error)
      else pending.reject?.(error)
    }
    this.pending.clear()
  }

  private resolveWaiters(): void {
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.resolve()
    }
  }

  private rejectWaiters(error: RemoteError): void {
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
  }
}
