import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { afterAll, describe, expect, it } from 'vitest'
import { WebServer, resolveStaticPath, tokenEquals } from '@open-harness/dsh-host-webserver'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TOKEN = 'tok-teste-123'
const dirs: string[] = []
const servers: WebServer[] = []

/** Directório estático com index, ficheiro comprimível e subdirectório. */
function staticDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-web-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'deep'), { recursive: true })
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>dsh</title>', 'utf8')
  writeFileSync(join(dir, 'app.js'), `console.log(${'"x", '.repeat(200)}0)`, 'utf8')
  writeFileSync(join(dir, 'deep', 'nota.txt'), 'aninhado', 'utf8')
  return dir
}

afterAll(() => {
  for (const server of servers) void server.close()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

type StartOptions = Partial<ConstructorParameters<typeof WebServer>[0]>

async function start(options: StartOptions = {}): Promise<WebServer> {
  const server = await WebServer.listen({ token: TOKEN, ...options })
  servers.push(server)
  return server
}

interface RawResponse {
  status: number
  body: string
  headers: Record<string, string | string[] | undefined>
}

/** GET com headers arbitrários, sem normalizar o caminho (testes de traversal). */
function rawGet(server: WebServer, path: string, headers: Record<string, string> = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: server.host, port: server.port, path, method: 'GET', headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
          headers: res.headers,
        }),
      )
    })
    req.on('error', reject)
    req.end()
  })
}

const authed = (extra: Record<string, string> = {}): Record<string, string> => ({
  authorization: `Bearer ${TOKEN}`,
  ...extra,
})

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe('auth por token', () => {
  it('compara em tempo constante e tolera tamanhos diferentes', () => {
    expect(tokenEquals('abc', 'abc')).toBe(true)
    expect(tokenEquals('abc', 'abd')).toBe(false)
    expect(tokenEquals('abc', 'ab')).toBe(false)
    expect(tokenEquals('', '')).toBe(false)
  })

  it('recusa pedidos sem token', async () => {
    const server = await start()
    const res = await rawGet(server, '/api/health')
    expect(res.status).toBe(401)
    expect(res.headers['www-authenticate']).toBe('Bearer')
  })

  it('aceita header Bearer e query access_token', async () => {
    const server = await start()
    expect((await rawGet(server, '/api/health', authed())).status).toBe(200)
    expect((await rawGet(server, `/api/health?access_token=${TOKEN}`)).status).toBe(200)
  })

  it('recusa token errado mesmo com o prefixo correcto', async () => {
    const server = await start()
    expect((await rawGet(server, `/api/health?access_token=${TOKEN}x`)).status).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// Rotas
// ---------------------------------------------------------------------------

describe('rotas', () => {
  it('reporta prontidão com as rotas e upgrades montados', async () => {
    const server = await start()
    server.use('/api/demo', (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
    server.upgrade('/api/remote.mux', () => undefined)

    const res = await rawGet(server, '/api/health', authed())
    const body = JSON.parse(res.body) as { ok: boolean; routes: string[]; upgrades: string[] }
    expect(body.ok).toBe(true)
    expect(body.routes).toContain('/api/demo')
    expect(body.upgrades).toEqual(['/api/remote.mux'])
  })

  it('escolhe a rota pelo prefixo mais específico', async () => {
    const server = await start()
    server.use('/api', (_req, res) => {
      res.writeHead(200)
      res.end('raiz')
    })
    server.use('/api/remoto', (_req, res) => {
      res.writeHead(200)
      res.end('especifico')
    })
    expect((await rawGet(server, '/api/remoto', authed())).body).toBe('especifico')
    expect((await rawGet(server, '/api/outra', authed())).body).toBe('raiz')
  })

  it('devolve 404 para rotas de API sem handler', async () => {
    const server = await start()
    expect((await rawGet(server, '/api/desconhecido', authed())).status).toBe(404)
  })

  it('rejeita erro do handler com 500, sem vazar stack', async () => {
    const server = await start()
    server.use('/api/boom', () => {
      throw new Error('boom interno')
    })
    const res = await rawGet(server, '/api/boom', authed())
    expect(res.status).toBe(500)
    expect(res.body).toContain('boom interno')
    expect(res.body).not.toContain('    at ')
  })
})

// ---------------------------------------------------------------------------
// Estático
// ---------------------------------------------------------------------------

describe('estático', () => {
  it('serve ficheiros com MIME correcto e SPA fallback', async () => {
    const server = await start({ staticDir: staticDir() })

    const index = await rawGet(server, '/', authed())
    expect(index.status).toBe(200)
    expect(index.headers['content-type']).toContain('text/html')

    expect((await rawGet(server, '/deep/nota.txt', authed())).body).toBe('aninhado')

    // Rota de UI sem ficheiro correspondente → index.html (SPA).
    const spa = await rawGet(server, '/sessao/abc', authed())
    expect(spa.status).toBe(200)
    expect(spa.body).toContain('<!doctype html>')
  })

  it('bloqueia path traversal', async () => {
    const server = await start({ staticDir: staticDir() })
    for (const path of ['/%2e%2e/package.json', '/deep/%2e%2e/%2e%2e/package.json', '/..%2fpackage.json']) {
      const res = await rawGet(server, path, authed())
      expect(res.status).toBe(400)
      expect(res.body).not.toContain('"name"')
    }
  })

  it('devolve 304 com ETag estável', async () => {
    const server = await start({ staticDir: staticDir() })
    const etag = (await rawGet(server, '/deep/nota.txt', authed())).headers.etag
    expect(etag).toBeTruthy()

    const second = await rawGet(server, '/deep/nota.txt', authed({ 'if-none-match': String(etag) }))
    expect(second.status).toBe(304)
    expect(second.body).toBe('')
  })

  it('comprime quando o cliente aceita', async () => {
    const server = await start({ staticDir: staticDir(), compressFrom: 256 })

    const compressed = await rawGet(server, '/app.js', authed({ 'accept-encoding': 'gzip, br' }))
    expect(compressed.status).toBe(200)
    expect(compressed.headers['content-encoding']).toBe('br')

    const plain = await rawGet(server, '/app.js', authed({ 'accept-encoding': 'identity' }))
    expect(plain.headers['content-encoding']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

describe('upgrade WebSocket', () => {
  function connect(server: WebServer, path: string, token = TOKEN): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://${server.host}:${server.port}${path}?access_token=${token}`)
      ws.once('open', () => resolve(ws))
      ws.once('error', reject)
    })
  }

  it('entrega o socket ao anexador do caminho montado', async () => {
    const server = await start()
    const inbox: string[] = []
    server.upgrade('/api/remote.mux', (socket) => {
      socket.on('message', (data: unknown) => inbox.push(String(data)))
      socket.send('ola do host')
    })

    const ws = await connect(server, '/api/remote.mux')
    const message = await new Promise<string>((resolve) => ws.once('message', (data) => resolve(String(data))))
    expect(message).toBe('ola do host')

    ws.send('ola do cliente')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(inbox).toEqual(['ola do cliente'])
    ws.close()
  })

  it('recusa upgrade sem token e em caminho não montado', async () => {
    const server = await start()
    server.upgrade('/api/remote.mux', () => undefined)

    await expect(connect(server, '/api/remote.mux', 'errado')).rejects.toThrow()
    await expect(connect(server, '/api/outro')).rejects.toThrow()
  })

  it('termina as ligações no shutdown', async () => {
    const server = await start()
    server.upgrade('/api/remote.mux', () => undefined)
    const ws = await connect(server, '/api/remote.mux')
    const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)))
    await server.close()
    expect(await closed).toBe(1006)
  })
})

describe('resolveStaticPath', () => {
  const root = join(tmpdir(), 'dsh-static-root')

  it('resolve dentro da raiz e recusa o que sai', () => {
    expect(resolveStaticPath(root, '/index.html')).toBe(join(root, 'index.html'))
    expect(resolveStaticPath(root, 'index.html')).toBe(join(root, 'index.html'))
    expect(resolveStaticPath(root, '/../secreto.txt')).toBeNull()
    expect(resolveStaticPath(root, '/a/../../secreto.txt')).toBeNull()
    expect(resolveStaticPath(root, '/com%00zero')).toBeNull()
    expect(resolveStaticPath(root, '/%ZZ')).toBeNull()
  })
})
