import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  Gateway,
  PROTOCOL_VERSION,
  RemoteError,
  WS_CLOSE_HEARTBEAT,
  WS_CLOSE_PROTOCOL,
  createGateway,
  createHttpRpc,
  createMuxHandler,
  type ClientFrame,
  type GatewaySocket,
  type MuxOptions,
  type ServerFrame,
} from '@open-harness/dsh-api-gateway'

// ---------------------------------------------------------------------------
// Socket em memória
//
// O gateway nunca fala `ws` directamente — só a interface estrutural
// `GatewaySocket`. Isto deixa testar o protocolo completo sem rede: dois
// objectos ligados, um a fazer de host e outro de browser.
// ---------------------------------------------------------------------------

type Listener = (...args: never[]) => void

class FakeSocket implements GatewaySocket {
  readyState = 1
  /** Molduras **recebidas** por este lado. */
  readonly inbox: ServerFrame[] = []
  peer: FakeSocket | undefined
  closeCode: number | undefined
  closeReason: string | undefined

  private readonly listeners = new Map<string, Listener[]>()

  on(event: 'message', listener: (data: unknown) => void): this
  on(event: 'close', listener: (code: number, reason: Buffer) => void): this
  on(event: 'error', listener: (error: Error) => void): this
  on(event: string, listener: Listener): this {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
    return this
  }

  /** Envia para o par — é o que o host faz quando escreve no socket. */
  send(data: string): void {
    this.peer?.receive('message', data)
  }

  close(code = 1000, reason = 'closed'): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.closeCode = code
    this.closeReason = reason
    this.receive('close', code, Buffer.from(reason))
    this.peer?.closeFromPeer(code, reason)
  }

  /** Envia do browser para o host (enquadra a moldura). */
  sendToHost(frame: ClientFrame | Record<string, unknown>): void {
    this.peer?.receive('message', JSON.stringify(frame))
  }

  /** Entrega um evento a este lado: grava no inbox e notifica listeners. */
  receive(event: string, ...args: unknown[]): void {
    if (event === 'message') {
      // O host pode receber lixo (não-JSON) — o socket real também entrega.
      try {
        this.inbox.push(JSON.parse(String(args[0])) as ServerFrame)
      } catch {
        // não é moldura válida; o gateway ignora
      }
    }
    for (const listener of this.listeners.get(event) ?? []) listener(...(args as never[]))
  }

  private closeFromPeer(code: number, reason: string): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.closeCode = code
    this.closeReason = reason
    this.receive('close', code, Buffer.from(reason))
  }

  /** Nº de molduras de um certo tipo recebidas. */
  count(kind: ServerFrame['kind']): number {
    return this.inbox.filter((frame) => frame.kind === kind).length
  }

  /** Primeira moldura de um certo tipo recebida. */
  first<T extends ServerFrame['kind']>(kind: T): Extract<ServerFrame, { kind: T }> | undefined {
    return this.inbox.find((frame) => frame.kind === kind) as Extract<ServerFrame, { kind: T }> | undefined
  }

  /** Espera até uma moldura satisfaçer o predicado. */
  async until(predicate: (frame: ServerFrame) => boolean, timeoutMs = 1000): Promise<void> {
    const started = Date.now()
    while (!this.inbox.some(predicate)) {
      if (Date.now() - started > timeoutMs) {
        throw new Error(`timeout: inbox = ${JSON.stringify(this.inbox)}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
  }
}

function socketPair(): { client: FakeSocket; server: FakeSocket } {
  const client = new FakeSocket()
  const server = new FakeSocket()
  client.peer = server
  server.peer = client
  return { client, server }
}

// ---------------------------------------------------------------------------
// Gateway de demonstração
// ---------------------------------------------------------------------------

interface DemoHooks {
  /** Chamado quando uma chamada pendurada é abortada. */
  onAborted?(): void
}

/** Fica pendurado até o sinal abortar — é como um turno em curso é cancelado. */
function holdUntilAborted(signal: AbortSignal, hooks: DemoHooks): Promise<void> {
  return new Promise<void>((resolve) => {
    const finish = (): void => {
      hooks.onAborted?.()
      resolve()
    }
    if (signal.aborted) finish()
    else signal.addEventListener('abort', finish, { once: true })
  })
}

function demoGateway(hooks: DemoHooks = {}): Gateway {
  return createGateway([
    {
      namespace: 'math',
      methods: {
        add: { handler: (params: { a: number; b: number }) => params.a + params.b },
        boom: {
          handler: () => {
            throw new RemoteError('invalid_params', 'parâmetros inválidos')
          },
        },
        crash: {
          handler: () => {
            throw new Error('stack interno não deve sair')
          },
        },
        /** Streaming determinístico: `n` itens com um intervalo curto. */
        count: {
          kind: 'stream',
          async *handler(params: { n: number }) {
            for (let i = 0; i < params.n; i++) {
              yield { i }
              await new Promise((resolve) => setTimeout(resolve, 2))
            }
          },
        },
        /** Fica pendente até ser cancelado (testa cancelamento e queda). */
        hold: {
          kind: 'stream',
          async *handler(_params: unknown, ctx) {
            yield 'antes'
            await holdUntilAborted(ctx.signal, hooks)
            yield 'depois'
          },
        },
      },
    },
    {
      methods: {
        /** Unary pendurado — testa a queda da ligação no mux. */
        wait: {
          handler: (_params: unknown, ctx) => holdUntilAborted(ctx.signal, hooks),
        },
      },
    },
  ])
}

interface Attached {
  client: FakeSocket
  gateway: Gateway
}

/** Anexa uma ligação de teste ao gateway e devolve o lado do browser. */
function attach(gateway: Gateway, options: MuxOptions = {}): Attached {
  const handler = createMuxHandler(gateway, { heartbeatMs: 60_000, ...options })
  const { client, server } = socketPair()
  handler.attach(server)
  return { client, gateway }
}

function call(client: FakeSocket, id: string, method: string, params?: unknown): void {
  client.sendToHost({ v: PROTOCOL_VERSION, kind: 'call', id, method, params })
}

// ---------------------------------------------------------------------------
// Registry do gateway
// ---------------------------------------------------------------------------

describe('Gateway', () => {
  it('lista métodos com namespace e distingue unary de stream', () => {
    const gateway = demoGateway()
    expect(gateway.list()).toEqual(['math.add', 'math.boom', 'math.count', 'math.crash', 'math.hold', 'wait'])
    expect(gateway.kindOf('math.add')).toBe('unary')
    expect(gateway.kindOf('math.count')).toBe('stream')
    expect(gateway.kindOf('math.nada')).toBeNull()
    expect(gateway.has('wait')).toBe(true)
  })

  it('recusa unary num método de stream e vice-versa', async () => {
    const gateway = demoGateway()
    const ctx = { method: '', signal: new AbortController().signal, connection: { id: 't', send: () => undefined } }
    await expect(gateway.call('math.count', { n: 1 }, ctx)).rejects.toThrow(/stream method/)
    await expect(gateway.stream('math.add', {}, ctx).next()).rejects.toThrow(/unary method/)
  })

  it('devolve method_not_found com a lista de conhecidos', async () => {
    const gateway = demoGateway()
    const ctx = { method: 'x', signal: new AbortController().signal, connection: { id: 't', send: () => undefined } }
    await expect(gateway.call('math.nada', {}, ctx)).rejects.toMatchObject({
      code: 'method_not_found',
    })
  })
})

// ---------------------------------------------------------------------------
// Mux WebSocket
// ---------------------------------------------------------------------------

describe('mux WebSocket', () => {
  it('anuncia o welcome com heartbeat e métodos', async () => {
    const { client } = attach(demoGateway(), { heartbeatMs: 1234 })
    await client.until((frame) => frame.kind === 'welcome')
    const welcome = client.first('welcome')
    expect(welcome?.heartbeatMs).toBe(1234)
    expect(welcome?.methods).toContain('math.add')
    expect(welcome?.methods).toContain('wait')
  })

  it('multiplexa chamadas unary independentes no mesmo socket', async () => {
    const { client } = attach(demoGateway())
    call(client, 'a', 'math.add', { a: 2, b: 3 })
    call(client, 'b', 'math.add', { a: 10, b: 40 })
    await client.until((frame) => frame.kind === 'result' && frame.id === 'b')

    expect(client.inbox.filter((frame) => frame.kind === 'result')).toEqual([
      expect.objectContaining({ id: 'a', result: 5 }),
      expect.objectContaining({ id: 'b', result: 50 }),
    ])
  })

  it('transporta streams multiplexados com data… end por chamada', async () => {
    const { client } = attach(demoGateway())
    call(client, 's1', 'math.count', { n: 3 })
    call(client, 'u1', 'math.add', { a: 1, b: 1 })
    await client.until((frame) => frame.kind === 'end' && frame.id === 's1')

    const datas = client.inbox.filter((frame) => frame.kind === 'data' && frame.id === 's1')
    expect(datas.map((frame) => (frame as { data: { i: number } }).data.i)).toEqual([0, 1, 2])
    expect(client.count('end')).toBe(1)
    // A chamada unary intercalou-se com o stream sem lhe tocar.
    expect(client.inbox.some((frame) => frame.kind === 'result' && frame.id === 'u1')).toBe(true)
  })

  it('propaga erros do handler sem vazar stack interna', async () => {
    const { client } = attach(demoGateway())
    call(client, 'e1', 'math.boom')
    call(client, 'e2', 'math.crash')
    call(client, 'e3', 'math.nada')
    await client.until((frame) => frame.kind === 'error' && frame.id === 'e3')

    const boom = client.inbox.find((frame) => frame.kind === 'error' && frame.id === 'e1')
    expect(boom).toMatchObject({ error: { code: 'invalid_params', message: 'parâmetros inválidos' } })

    const crash = client.inbox.find((frame) => frame.kind === 'error' && frame.id === 'e2') as {
      error: { code: string; message: string }
    }
    expect(crash.error.code).toBe('internal')
    expect(crash.error.message).toBe('stack interno não deve sair')
    expect(JSON.stringify(crash)).not.toContain('at ')

    const nada = client.inbox.find((frame) => frame.kind === 'error' && frame.id === 'e3') as {
      error: { code: string; data: { known: string[] } }
    }
    expect(nada.error.data.known).toContain('math.add')
  })

  it('cancela uma chamada em curso e não entrega o resto do stream', async () => {
    const { client } = attach(demoGateway())
    call(client, 'h1', 'math.hold')
    await client.until((frame) => frame.kind === 'data' && frame.id === 'h1')

    client.sendToHost({ v: PROTOCOL_VERSION, kind: 'cancel', id: 'h1' })
    await client.until((frame) => frame.kind === 'end' && frame.id === 'h1')

    const datas = client.inbox.filter((frame) => frame.kind === 'data' && frame.id === 'h1')
    expect(datas).toHaveLength(1)
    expect(datas[0]).toMatchObject({ data: 'antes' })
  })

  it('rejeita id de chamada duplicado', async () => {
    const { client } = attach(demoGateway())
    call(client, 'dup', 'math.add', { a: 1, b: 1 })
    call(client, 'dup', 'math.add', { a: 2, b: 2 })
    await client.until((frame) => frame.kind === 'error' && frame.id === 'dup')

    const duplicate = client.inbox.find(
      (frame) => frame.kind === 'error' && frame.id === 'dup' && frame.error.code === 'invalid_params',
    )
    expect(duplicate).toBeTruthy()
  })

  it('leva uplink do cliente', async () => {
    const uplinks: Array<{ channel: string; payload: unknown }> = []
    const { client } = attach(demoGateway(), {
      onUplink: (channel, payload) => uplinks.push({ channel, payload }),
    })

    client.sendToHost({ v: PROTOCOL_VERSION, kind: 'event', channel: 'client.log', payload: { line: 'oi' } })
    expect(uplinks).toEqual([{ channel: 'client.log', payload: { line: 'oi' } }])
  })

  it('envia downlink pelo canal do handler', async () => {
    const gateway = demoGateway()
    const handler = createMuxHandler(gateway, { heartbeatMs: 60_000 })
    const { client, server } = socketPair()
    const connection = handler.attach(server)
    await client.until((frame) => frame.kind === 'welcome')

    connection.send('host.event', { hello: true })
    await client.until((frame) => frame.kind === 'up')
    expect(client.first('up')).toMatchObject({ channel: 'host.event', payload: { hello: true } })
    expect(connection.id).toBeTypeOf('string')
  })

  it('ignora molduras que não são JSON e frames malformados', async () => {
    const { client } = attach(demoGateway())
    client.peer?.receive('message', 'isto não é json')
    client.sendToHost({ v: PROTOCOL_VERSION, kind: 'call', id: '', method: '' })
    call(client, 'ok', 'math.add', { a: 1, b: 2 })
    await client.until((frame) => frame.kind === 'result' && frame.id === 'ok')
    expect(client.first('result')?.result).toBe(3)
  })

  it('fecha a ligação em versão de protocolo desconhecida', async () => {
    const { client } = attach(demoGateway())
    client.sendToHost({ v: 99, kind: 'call', id: 'x', method: 'math.add', params: {} })
    expect(client.closeCode).toBe(WS_CLOSE_PROTOCOL)
  })

  it('aborta as chamadas em curso quando a ligação cai', async () => {
    let aborted = false
    const { client } = attach(demoGateway({ onAborted: () => (aborted = true) }))
    call(client, 'w1', 'wait')
    await new Promise((resolve) => setTimeout(resolve, 5))

    client.close(1001, 'browser fechado')
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(aborted).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

describe('heartbeat', () => {
  it('fecha a ligação quando o cliente deixa de responder', async () => {
    const { client } = attach(demoGateway(), { heartbeatMs: 20, missedPings: 2 })
    await client.until((frame) => frame.kind === 'ping')
    // Sem `pong`, o host tem de desistir da ligação.
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(client.closeCode).toBe(WS_CLOSE_HEARTBEAT)
  })

  it('mantém a ligação com pongs regulares', async () => {
    const { client } = attach(demoGateway(), { heartbeatMs: 20, missedPings: 2 })
    const ponging = setInterval(() => {
      client.sendToHost({ v: PROTOCOL_VERSION, kind: 'pong', t: Date.now() })
    }, 15)
    try {
      await client.until((frame) => frame.kind === 'ping')
      await new Promise((resolve) => setTimeout(resolve, 120))
      expect(client.closeCode).toBeUndefined()
      expect(client.count('ping')).toBeGreaterThan(2)
    } finally {
      clearInterval(ponging)
    }
  })
})

// ---------------------------------------------------------------------------
// Caminho HTTP/SSE
// ---------------------------------------------------------------------------

interface SseEvent {
  event: string
  data: unknown
}

function parseSse(text: string): SseEvent[] {
  return text
    .split('\n\n')
    .filter((block) => block.trim())
    .map((block) => ({
      event: /event: (.+)/.exec(block)?.[1] ?? 'message',
      data: JSON.parse(/data: (.+)/.exec(block)?.[1] ?? 'null'),
    }))
}

describe('caminho HTTP', () => {
  let server: Server | undefined

  afterEach(async () => {
    const current = server
    server = undefined
    if (current) await new Promise<void>((resolve) => current.close(() => resolve()))
  })

  async function serve(gateway: Gateway): Promise<string> {
    const rpc = createHttpRpc(gateway)
    server = createServer((req, res) => {
      if (req.url === '/api/remote/stream') void rpc.stream(req, res)
      else void rpc.unary(req, res)
    })
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()))
    const { port } = server.address() as AddressInfo
    return `http://127.0.0.1:${port}`
  }

  it('resolve chamadas unary por POST', async () => {
    const url = await serve(demoGateway())
    const res = await fetch(`${url}/api/remote`, {
      method: 'POST',
      body: JSON.stringify({ method: 'math.add', params: { a: 4, b: 5 } }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ v: PROTOCOL_VERSION, result: 9 })
  })

  it('devolve RemoteError como JSON, com 400', async () => {
    const url = await serve(demoGateway())
    const res = await fetch(`${url}/api/remote`, {
      method: 'POST',
      body: JSON.stringify({ method: 'math.nada', params: {} }),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { code: 'method_not_found' } })
  })

  it('valida método e corpo', async () => {
    const url = await serve(demoGateway())
    const semMethod = await fetch(`${url}/api/remote`, { method: 'POST', body: '{}' })
    expect(semMethod.status).toBe(400)
    expect(await semMethod.json()).toMatchObject({ error: { code: 'invalid_params' } })

    const get = await fetch(`${url}/api/remote`)
    expect(get.status).toBe(405)

    const naoJson = await fetch(`${url}/api/remote`, { method: 'POST', body: 'não json' })
    expect(naoJson.status).toBe(400)
  })

  it('serve streams por SSE com open, data… e end', async () => {
    const url = await serve(demoGateway())
    const res = await fetch(`${url}/api/remote/stream`, {
      method: 'POST',
      body: JSON.stringify({ method: 'math.count', params: { n: 2 } }),
    })
    expect(res.headers.get('content-type')).toContain('text/event-stream')

    const events = parseSse(await res.text())
    expect(events.map((event) => event.event)).toEqual(['open', 'data', 'data', 'end'])
    expect(events[1].data).toEqual({ i: 0 })
    expect(events[2].data).toEqual({ i: 1 })
  })

  it('reporta erro a meio de um stream', async () => {
    const url = await serve(demoGateway())
    const res = await fetch(`${url}/api/remote/stream`, {
      method: 'POST',
      body: JSON.stringify({ method: 'math.boom', params: {} }),
    })
    const events = parseSse(await res.text())
    expect(events.map((event) => event.event)).toEqual(['open', 'error'])
    expect(events[1].data).toMatchObject({ code: 'invalid_params' })
  })

  it('aborta o handler quando o browser desliga a meio do stream', async () => {
    let aborted = false
    const gateway = demoGateway({ onAborted: () => (aborted = true) })
    const url = await serve(gateway)

    const controller = new AbortController()
    const res = await fetch(`${url}/api/remote/stream`, {
      method: 'POST',
      body: JSON.stringify({ method: 'math.hold', params: {} }),
      signal: controller.signal,
    })
    // Lê a moldura inicial (o `open` e o primeiro `data`) e desliga.
    const reader = res.body?.getReader()
    await reader?.read()
    controller.abort()

    // O fecho do socket tem de chegar ao handler — é aí que se prova que o
    // trabalho em curso é cancelado, e não deixado a correr em vão.
    const started = Date.now()
    while (!aborted && Date.now() - started < 1000) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(aborted).toBe(true)
  })
})
