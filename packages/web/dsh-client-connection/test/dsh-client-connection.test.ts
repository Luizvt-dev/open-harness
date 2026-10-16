import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  Gateway,
  createGateway,
  createHttpRpc,
  createMuxHandler,
  type MuxHandler,
} from '@open-harness/dsh-api-gateway'
import { WebServer } from '@open-harness/dsh-host-webserver'
import { HttpClient, createClient } from '@open-harness/dsh-client-connection'

// ---------------------------------------------------------------------------
// Harness de ponta a ponta: servidor real + gateway + clientes reais.
//
// Não há browser aqui — o `WebSocket` global do Node é o mesmo protocolo, e o
// `fetch` também. É precisamente o que torna o cliente testável sem UI.
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timeout à espera de condição')
    await sleep(5)
  }
}

interface Harness {
  server: WebServer
  mux: MuxHandler
  url: string
  token: string
}

function demoGateway(hooks: { onAborted?(): void } = {}): Gateway {
  return createGateway([
    {
      namespace: 'demo',
      methods: {
        add: { handler: (params: { a: number; b: number }) => params.a + params.b },
        crash: {
          handler: () => {
            throw new Error('stack interno não deve sair')
          },
        },
        count: {
          kind: 'stream',
          async *handler(params: { n: number }) {
            for (let i = 0; i < params.n; i++) {
              yield { i }
              await sleep(2)
            }
          },
        },
        /** Fica pendurado até o transporte cancelar ou a ligação cair. */
        hold: {
          kind: 'stream',
          async *handler(_params: unknown, ctx) {
            yield 'antes'
            await new Promise<void>((resolve) => {
              const finish = (): void => {
                hooks.onAborted?.()
                resolve()
              }
              if (ctx.signal.aborted) finish()
              else ctx.signal.addEventListener('abort', finish, { once: true })
            })
            yield 'depois'
          },
        },
      },
    },
  ])
}

async function startHarness(
  options: { heartbeatMs?: number; onAborted?(): void; token?: string } = {},
): Promise<Harness> {
  const token = options.token ?? randomBytes(16).toString('hex')
  const gateway = demoGateway({ onAborted: options.onAborted })
  const mux = createMuxHandler(gateway, { heartbeatMs: options.heartbeatMs ?? 60_000 })
  const rpc = createHttpRpc(gateway)
  const server = await WebServer.listen({ token })
  server.use('/api/remote', rpc.unary)
  server.use('/api/remote/stream', rpc.stream)
  server.upgrade('/api/remote.mux', mux.attach)
  return { server, mux, url: server.baseUrl, token }
}

// ---------------------------------------------------------------------------

describe('cliente mux (WebSocket)', () => {
  it('resolve chamadas unary pelo mesmo socket', async () => {
    const harness = await startHarness()
    const client = createClient({ url: harness.url, token: harness.token })
    try {
      await client.whenOpen()
      expect(client.state).toBe('open')
      expect(await client.call('demo.add', { a: 2, b: 3 })).toBe(5)
      // Várias chamadas em paralelo no mesmo socket.
      const results = await Promise.all([
        client.call('demo.add', { a: 1, b: 1 }),
        client.call('demo.add', { a: 10, b: 20 }),
      ])
      expect(results).toEqual([2, 30])
    } finally {
      client.close()
      await harness.server.close()
    }
  })

  it('devolve RemoteError sem stack interna', async () => {
    const harness = await startHarness()
    const client = createClient({ url: harness.url, token: harness.token })
    try {
      await client.whenOpen()
      await expect(client.call('demo.crash')).rejects.toMatchObject({
        code: 'internal',
        message: 'stack interno não deve sair',
      })
      await expect(client.call('demo.nada')).rejects.toMatchObject({ code: 'method_not_found' })
    } finally {
      client.close()
      await harness.server.close()
    }
  })

  it('consome streams e cancela quando o consumidor desiste', async () => {
    let aborted = false
    const harness = await startHarness({ onAborted: () => (aborted = true) })
    const client = createClient({ url: harness.url, token: harness.token })
    try {
      await client.whenOpen()

      const items: Array<{ i: number }> = []
      for await (const item of client.stream<{ i: number }>('demo.count', { n: 3 })) items.push(item)
      expect(items.map((item) => item.i)).toEqual([0, 1, 2])

      // Sai a meio do `hold`: o host tem de receber o cancelamento.
      for await (const chunk of client.stream('demo.hold', {})) {
        expect(chunk).toBe('antes')
        break
      }
      await until(() => aborted)
      expect(aborted).toBe(true)
    } finally {
      client.close()
      await harness.server.close()
    }
  })

  it('leva uplink para o host e downlink para o cliente', async () => {
    const uplinks: Array<{ channel: string; payload: unknown }> = []
    const gateway = demoGateway()
    const mux = createMuxHandler(gateway, {
      heartbeatMs: 60_000,
      onUplink: (channel, payload) => uplinks.push({ channel, payload }),
    })
    const server = await WebServer.listen({ token: 'tok-uplink' })
    server.upgrade('/api/remote.mux', mux.attach)

    const client = createClient({ url: server.baseUrl, token: 'tok-uplink' })
    const seen: unknown[] = []
    client.on('host.event', (payload) => seen.push(payload))
    try {
      await client.whenOpen()
      client.send('client.log', { line: 'oi' })
      // O frame atravessa o socket — dá-lhe o tempo de chegar.
      await until(() => uplinks.length > 0)
      expect(uplinks).toEqual([{ channel: 'client.log', payload: { line: 'oi' } }])

      const connection = [...mux.connections][0]
      connection?.send('host.event', { hello: true })
      await until(() => seen.length > 0)
      expect(seen).toEqual([{ hello: true }])
    } finally {
      client.close()
      await server.close()
    }
  })

  it('fala o heartbeat — a ligação vive com pongs regulares', async () => {
    // Margem realista: o host só fecha depois de `heartbeatMs × missedPings(3)`
    // sem pong — com 25 ms isso eram 75 ms de janela, e sob a carga da suíte
    // inteira o pong atrasava-se e o host (por direito) fechava. 250 ms dá
    // 750 ms de tolerância; a prova continua a mesma: sem pongs, ao fim de
    // 1 s a ligação já teria caído.
    const harness = await startHarness({ heartbeatMs: 250 })
    const client = createClient({ url: harness.url, token: harness.token })
    try {
      await client.whenOpen()
      // 4 intervalos de 250 ms: sem resposta aos pings o host teria fechado.
      await sleep(1000)
      expect(client.state).toBe('open')
      expect(await client.call('demo.add', { a: 4, b: 5 })).toBe(9)
    } finally {
      client.close()
      await harness.server.close()
    }
  })

  it('falha as chamadas pendentes quando a ligação cai', async () => {
    const harness = await startHarness()
    const client = createClient({
      url: harness.url,
      token: harness.token,
      reconnect: { baseDelayMs: 5, maxDelayMs: 20 },
    })
    try {
      await client.whenOpen()
      const iterator = client.stream('demo.hold', {})
      expect(await iterator.next()).toMatchObject({ value: 'antes' })

      // O host derruba a ligação a meio do stream.
      for (const connection of harness.mux.connections) connection.close()
      await expect(iterator.next()).rejects.toMatchObject({ code: 'unavailable' })
    } finally {
      client.close()
      await harness.server.close()
    }
  })

  it('reconecta com geração nova e volta a servir chamadas', async () => {
    const harness = await startHarness()
    const client = createClient({
      url: harness.url,
      token: harness.token,
      reconnect: { baseDelayMs: 5, maxDelayMs: 20 },
    })
    try {
      await client.whenOpen()
      expect(client.generation).toBe(1)
      expect(await client.call('demo.add', { a: 1, b: 2 })).toBe(3)

      for (const connection of harness.mux.connections) connection.close()
      await until(() => client.generation >= 2, 3000)

      // A geração nova serve chamadas como antes.
      expect(await client.call('demo.add', { a: 7, b: 8 })).toBe(15)
    } finally {
      client.close()
      await harness.server.close()
    }
  })

  it('não reconecta quando desligado à mão', async () => {
    const harness = await startHarness()
    const client = createClient({
      url: harness.url,
      token: harness.token,
      reconnect: { baseDelayMs: 5, maxDelayMs: 20 },
    })
    try {
      await client.whenOpen()
      client.close()
      expect(client.state).toBe('closed')
      await expect(client.call('demo.add', { a: 1, b: 1 })).rejects.toMatchObject({ code: 'unavailable' })
      const generation = client.generation
      await sleep(60)
      expect(client.generation).toBe(generation)
    } finally {
      await harness.server.close()
    }
  })

  it('recusa token errado no handshake', async () => {
    const harness = await startHarness()
    const client = createClient({ url: harness.url, token: 'errado', reconnect: false })
    try {
      await expect(client.whenOpen(500)).rejects.toMatchObject({ code: 'unavailable' })
      expect(client.state).toBe('closed')
    } finally {
      client.close()
      await harness.server.close()
    }
  })
})

describe('cliente HTTP/SSE', () => {
  async function start(): Promise<Harness> {
    const token = randomBytes(16).toString('hex')
    const gateway = demoGateway()
    const rpc = createHttpRpc(gateway)
    const server = await WebServer.listen({ token })
    server.use('/api/remote', rpc.unary)
    server.use('/api/remote/stream', rpc.stream)
    return { server, mux: createMuxHandler(gateway), url: server.baseUrl, token }
  }

  it('resolve unary e streams pelo caminho HTTP', async () => {
    const harness = await start()
    const client = createClient({ url: harness.url, token: harness.token, transport: 'http' })
    try {
      expect(await client.call('demo.add', { a: 5, b: 6 })).toBe(11)

      const items: Array<{ i: number }> = []
      for await (const item of client.stream<{ i: number }>('demo.count', { n: 2 })) items.push(item)
      expect(items.map((item) => item.i)).toEqual([0, 1])
    } finally {
      client.close()
      await harness.server.close()
    }
  })

  it('devolve erros do host e recusa token errado', async () => {
    const harness = await start()
    const client = new HttpClient({ url: harness.url, token: harness.token })
    const anonymous = new HttpClient({ url: harness.url, token: 'errado' })
    try {
      await expect(client.call('demo.nada')).rejects.toMatchObject({ code: 'method_not_found' })
      await expect(anonymous.call('demo.add', { a: 1, b: 1 })).rejects.toMatchObject({ code: 'unauthorized' })
    } finally {
      await harness.server.close()
    }
  })

  it('lança ao tentar uplink — não existe neste transporte', () => {
    const client = new HttpClient({ url: 'http://127.0.0.1:1', token: 'x' })
    expect(() => client.send('client.log', {})).toThrow(/uplink/)
    // Sem canal persistente, subscrever devolve um unsubscribe inócuo.
    const unsubscribe = client.on('canal', () => undefined)
    expect(typeof unsubscribe).toBe('function')
    unsubscribe()
  })
})
