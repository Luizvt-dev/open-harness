import { randomUUID } from 'node:crypto'
import { RemoteError } from './errors.js'
import type { Gateway } from './gateway.js'
import {
  PROTOCOL_VERSION,
  type CallContext,
  type ClientFrame,
  type GatewaySocket,
  type ServerFrame,
  type UplinkChannel,
} from './types.js'

/** WebSocket aberto. */
const WS_OPEN = 1
/** Fechamento normal. */
export const WS_CLOSE_NORMAL = 1000
/** Fechado por falta de heartbeat. */
export const WS_CLOSE_HEARTBEAT = 4000
/** Versão de protocolo não suportada. */
export const WS_CLOSE_PROTOCOL = 4001

export interface MuxOptions {
  /** Intervalo de `ping` (ms). Default 15 000. */
  heartbeatMs?: number
  /** Pings sem `pong` antes de fechar. Default 3. */
  missedPings?: number
  /** Handler de uplink — eventos enviados pelo cliente. */
  onUplink?(channel: string, payload: unknown, connection: UplinkChannel): void
  /** Observabilidade. */
  onLog?(line: string): void
}

interface InFlight {
  controller: AbortController
}

/**
 * Uma ligação multiplexada.
 *
 * Transporta tudo no mesmo socket: chamadas unary, streams, heartbeat e
 * uplink. O `id` da chamada é o que multiplexa — várias chamadas (e vários
 * streams) correm em simultâneo sem interferir.
 */
export class MuxConnection implements UplinkChannel {
  readonly id: string

  private readonly socket: GatewaySocket
  private readonly gateway: Gateway
  private readonly heartbeatMs: number
  private readonly missedPings: number
  private readonly onUplink: MuxOptions['onUplink']
  private readonly onLog: MuxOptions['onLog']
  private readonly calls = new Map<string, InFlight>()
  private timer: NodeJS.Timeout | undefined
  private lastPongAt = Date.now()
  private closed = false

  constructor(socket: GatewaySocket, gateway: Gateway, options: MuxOptions = {}) {
    this.id = randomUUID()
    this.socket = socket
    this.gateway = gateway
    this.heartbeatMs = options.heartbeatMs ?? 15_000
    this.missedPings = options.missedPings ?? 3
    this.onUplink = options.onUplink
    this.onLog = options.onLog

    this.socket.on('message', (data: unknown) => {
      void this.handleMessage(data)
    })
    this.socket.on('close', () => this.dispose())
    this.socket.on('error', (error: Error) => {
      this.onLog?.(`mux ${this.id.slice(0, 8)}: ${error.message}`)
      this.dispose()
    })
  }

  /** A ligação está viva? */
  get open(): boolean {
    return !this.closed && this.socket.readyState === WS_OPEN
  }

  /** Envia um evento do host para o cliente (downlink). */
  send(channel: string, payload: unknown): void {
    this.frame({ v: PROTOCOL_VERSION, kind: 'up', channel, payload })
  }

  /** Fecha a ligação e cancela tudo o que estiver a correr. */
  close(code = WS_CLOSE_NORMAL, reason = 'closed'): void {
    if (this.closed) return
    this.dispose()
    try {
      this.socket.close(code, reason)
    } catch {
      // O socket já pode ter morrido; o dispose já tratou do resto.
    }
  }

  /** Envia a moldura inicial com o heartbeat e a lista de métodos. */
  announce(): void {
    this.frame({
      v: PROTOCOL_VERSION,
      kind: 'welcome',
      heartbeatMs: this.heartbeatMs,
      serverTime: Date.now(),
      methods: this.gateway.list(),
    })
    this.startHeartbeat()
  }

  private frame(frame: ServerFrame): void {
    if (!this.open) return
    this.socket.send(JSON.stringify(frame))
  }

  private startHeartbeat(): void {
    this.timer = setInterval(() => {
      if (!this.open) {
        this.dispose()
        return
      }
      const missed = Date.now() - this.lastPongAt
      if (missed > this.heartbeatMs * this.missedPings) {
        this.onLog?.(`mux ${this.id.slice(0, 8)}: heartbeat timeout`)
        this.close(WS_CLOSE_HEARTBEAT, 'heartbeat timeout')
        return
      }
      this.frame({ v: PROTOCOL_VERSION, kind: 'ping', t: Date.now() })
    }, this.heartbeatMs)
    // Não segura o processo vivo por causa de uma ligação ociosa.
    this.timer.unref?.()
  }

  private async handleMessage(raw: unknown): Promise<void> {
    const text = toText(raw)
    if (!text) return
    let frame: ClientFrame
    try {
      frame = JSON.parse(text) as ClientFrame
    } catch {
      this.onLog?.(`mux ${this.id.slice(0, 8)}: frame is not JSON`)
      return
    }
    if (!frame || typeof frame !== 'object') return
    if (frame.v !== PROTOCOL_VERSION) {
      this.close(WS_CLOSE_PROTOCOL, 'unsupported protocol version')
      return
    }
    switch (frame.kind) {
      case 'call':
        await this.handleCall(frame.id, frame.method, frame.params)
        return
      case 'cancel':
        this.calls.get(frame.id)?.controller.abort()
        return
      case 'event':
        this.onUplink?.(frame.channel, frame.payload, this)
        return
      case 'pong':
        this.lastPongAt = Date.now()
        return
      default:
        this.onLog?.(`mux ${this.id.slice(0, 8)}: unknown frame kind`)
    }
  }

  private async handleCall(id: string, method: string, params: unknown): Promise<void> {
    if (typeof id !== 'string' || !id || typeof method !== 'string' || !method) {
      this.onLog?.(`mux ${this.id.slice(0, 8)}: malformed call frame`)
      return
    }
    if (this.calls.has(id)) {
      this.frame({
        v: PROTOCOL_VERSION,
        kind: 'error',
        id,
        error: new RemoteError('invalid_params', `duplicate call id "${id}"`).toShape(),
      })
      return
    }

    const controller = new AbortController()
    this.calls.set(id, { controller })
    const ctx: CallContext = { method, signal: controller.signal, connection: this }

    try {
      const kind = this.gateway.kindOf(method)
      if (kind === 'unary') {
        const result = await this.gateway.call(method, params, ctx)
        this.frame({ v: PROTOCOL_VERSION, kind: 'result', id, result: result ?? null })
      } else if (kind === 'stream') {
        for await (const data of this.gateway.stream(method, params, ctx)) {
          this.frame({ v: PROTOCOL_VERSION, kind: 'data', id, data: data ?? null })
        }
        this.frame({ v: PROTOCOL_VERSION, kind: 'end', id })
      } else {
        this.frame({
          v: PROTOCOL_VERSION,
          kind: 'error',
          id,
          error: this.gateway.methodNotFound(method).toShape(),
        })
      }
    } catch (error) {
      this.frame({
        v: PROTOCOL_VERSION,
        kind: 'error',
        id,
        error: RemoteError.from(error).toShape(),
      })
    } finally {
      this.calls.delete(id)
    }
  }

  private dispose(): void {
    if (this.closed) return
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    for (const call of this.calls.values()) call.controller.abort()
    this.calls.clear()
  }
}

function toText(raw: unknown): string {
  if (typeof raw === 'string') return raw
  if (Buffer.isBuffer(raw)) return raw.toString('utf8')
  if (Array.isArray(raw)) return Buffer.concat(raw as Buffer[]).toString('utf8')
  return ''
}

export interface MuxHandler {
  /** Ligações activas. */
  readonly connections: ReadonlySet<MuxConnection>
  /** Anexa um socket autenticado (pronto para usar). */
  attach(socket: GatewaySocket): MuxConnection
  /** Fecha todas as ligações. */
  closeAll(): void
}

/**
 * Cria o anexador de ligações para o `upgrade()` do servidor web.
 *
 * Depois de `server.upgrade('/api/remote.mux', handler.attach)`, cada browser
 * que complete o handshake recebe uma `MuxConnection` com o `welcome`
 * já enviado.
 */
export function createMuxHandler(gateway: Gateway, options: MuxOptions = {}): MuxHandler {
  const connections = new Set<MuxConnection>()
  return {
    get connections() {
      return connections
    },
    attach(socket: GatewaySocket): MuxConnection {
      const connection = new MuxConnection(socket, gateway, options)
      connections.add(connection)
      connection.announce()
      return connection
    },
    closeAll(): void {
      for (const connection of connections) connection.close()
      connections.clear()
    },
  }
}
