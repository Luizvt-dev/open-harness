import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createClient } from '@open-harness/dsh-client-connection'
import {
  ScriptedAdapter,
  ensureProfile,
  runCli,
  scriptedText,
  startWeb,
  webBundleDir,
  type WebHandle,
} from '@open-harness/dsh-cli'

// ---------------------------------------------------------------------------
// Acceptance da Fase 3: `dsh web` sobe o host e um cliente Node fala com ele
// por WebSocket (mux) e por HTTP/SSE — sem navegador, com o mesmo protocolo.
// ---------------------------------------------------------------------------

const temps: string[] = []

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}

afterAll(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true })
})

/** Sobe um host offline numa porta livre, com um workspace próprio. */
async function startOffline(): Promise<WebHandle & { workspace: string; home: string }> {
  const home = await tempDir('dsh-web-home-')
  const workspace = await tempDir('dsh-web-ws-')
  const handle = await startWeb({
    homeDir: home,
    cwd: workspace,
    port: 0,
    token: 'tok-teste',
    adapter: new ScriptedAdapter([], scriptedText('resposta offline: sei quem és, sem rede.')),
  })
  return Object.assign(handle, { workspace, home })
}

interface JobEvent {
  type: string
  [key: string]: unknown
}

async function runTurn(
  client: ReturnType<typeof createClient>,
  sessionId: string,
  text: string,
): Promise<JobEvent[]> {
  const events: JobEvent[] = []
  for await (const event of client.stream<JobEvent>('job.run', { sessionId, text })) {
    events.push(event)
  }
  return events
}

describe('dsh web (aceitação)', () => {
  it('materializa o perfil `web` a partir do bundle embutido', async () => {
    const home = await tempDir('dsh-web-profile-')
    const { profileDir, existed } = ensureProfile({ homeDir: home, name: 'web' })
    expect(existed).toBe(false)

    const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8')) as {
      dsh: { profile: { bundles: { path: string }[] } }
    }
    expect(manifest.dsh.profile.bundles[0]!.path).toBe(webBundleDir())
  })

  it('sobe o host e um cliente mux corre um turno de ponta a ponta', async () => {
    const host = await startOffline()
    const client = createClient({ url: host.url, token: host.token })
    try {
      await client.whenOpen()

      const session = await client.call<{ id: string; cwd: string; modelRef: string }>('session.create', {})
      expect(session.cwd).toBe(host.workspace)
      expect(session.modelRef).toBe('deepseek/deepseek-flash')

      const events = await runTurn(client, session.id, 'quem és tu?')
      const types = events.map((event) => event.type)
      expect(types[0]).toBe('job_start')
      expect(types).toContain('text_delta')
      expect(types.at(-1)).toBe('turn_end')

      const text = events
        .filter((event) => event.type === 'text_delta')
        .map((event) => event.text)
        .join('')
      expect(text).toContain('sem rede')

      // A sessão persistiu-se no disco do host.
      const entries = await readdir(host.home, { recursive: true })
      const sessionFile = entries.find((entry) => String(entry).endsWith('session.v4.jsonl.zstd'))
      expect(sessionFile).toBeTruthy()
      const raw = await readFile(join(host.home, String(sessionFile)), 'utf8').catch(() => '')
      expect(raw.length).toBeGreaterThan(0)
    } finally {
      client.close()
      await host.shutdown()
    }
  })

  it('o mesmo caminho funciona por HTTP/SSE', async () => {
    const host = await startOffline()
    const client = createClient({ url: host.url, token: host.token, transport: 'http' })
    try {
      const session = await client.call<{ id: string }>('session.create', {})

      const events = await runTurn(client, session.id, 'olá')
      expect(events.at(-1)?.type).toBe('turn_end')

      const info = await client.call<{ cwd: string; version: string }>('workspace.info', {})
      expect(info.cwd).toBe(host.workspace)
      expect(info.version).toMatch(/^\d+\.\d+\.\d+$/)
    } finally {
      client.close()
      await host.shutdown()
    }
  })

  it('expõe o workspace ao browser (listar, ler e escrever)', async () => {
    const host = await startOffline()
    await mkdir(join(host.workspace, 'src'), { recursive: true })
    await writeFile(join(host.workspace, 'src', 'main.ts'), 'export const x = 1\n', 'utf8')

    const client = createClient({ url: host.url, token: host.token })
    try {
      await client.whenOpen()
      const listed = await client.call<{ entries: Array<{ name: string; kind: string }> }>(
        'workspace.files.list',
        {},
      )
      expect(listed.entries.map((entry) => entry.name)).toContain('src')

      const read = await client.call<{ content: string }>('workspace.files.read', { path: 'src/main.ts' })
      expect(read.content).toBe('export const x = 1\n')

      await client.call('workspace.files.write', { path: 'nota.md', content: 'do browser' })
      expect(await readFile(join(host.workspace, 'nota.md'), 'utf8')).toBe('do browser')

      // Continua preso ao workspace.
      await expect(
        client.call('workspace.files.read', { path: '../fuga.txt' }),
      ).rejects.toMatchObject({ code: 'invalid_params' })
    } finally {
      client.close()
      await host.shutdown()
    }
  })

  it('recusa token errado e mostra a saúde do host', async () => {
    const host = await startOffline()
    try {
      const wrong = createClient({ url: host.url, token: 'errado', reconnect: false })
      try {
        await expect(wrong.whenOpen(500)).rejects.toMatchObject({ code: 'unavailable' })
      } finally {
        wrong.close()
      }

      const health = await fetch(`${host.url}/api/health`, {
        headers: { authorization: `Bearer ${host.token}` },
      })
      expect(health.status).toBe(200)
      expect(await health.json()).toMatchObject({ ok: true })
    } finally {
      await host.shutdown()
    }
  })

  it('serve a interface e os módulos do cliente ao navegador', async () => {
    const host = await startOffline()
    try {
      // O navegador carrega os activos sem headers: o cookie é o que os
      // autentica (o index.html grava-o logo na primeira carga).
      const cookie = { cookie: `access_token=${host.token}` }

      const page = await fetch(`${host.url}/`, { headers: cookie })
      expect(page.status).toBe(200)
      expect(page.headers.get('content-type')).toContain('text/html')
      const html = await page.text()
      // O import map é injectado pelo bootstrap (não é uma tag fixa).
      expect(html).toContain("map.type = 'importmap'")
      expect(html).toContain('/client/dsh-client-connection/index.js')
      expect(html).toContain('/client/dsh-api-gateway/browser.js')

      const app = await fetch(`${host.url}/app.js`, { headers: cookie })
      expect(app.status).toBe(200)
      expect(app.headers.get('content-type')).toContain('javascript')

      const styles = await fetch(`${host.url}/style.css`, { headers: cookie })
      expect(styles.status).toBe(200)
      expect(styles.headers.get('content-type')).toContain('text/css')

      // Os módulos que o import map resolve: o cliente do host e a entrada
      // browser do gateway — nunca a entrada `.`, que puxa node:crypto.
      const clientModule = await fetch(`${host.url}/client/dsh-client-connection/index.js`, { headers: cookie })
      expect(clientModule.status).toBe(200)
      expect(await clientModule.text()).toContain('./mux.js')

      const gatewayModule = await fetch(`${host.url}/client/dsh-api-gateway/browser.js`, { headers: cookie })
      expect(gatewayModule.status).toBe(200)
      const gatewaySource = await gatewayModule.text()
      expect(gatewaySource).toContain('./types.js')
      // Nenhum import estático de builtin — é isso que rebentava no browser
      // (a comentário pode mencioná-los à vontade; o que não pode é importá-los).
      expect(gatewaySource).not.toMatch(/from ['"]node:|import ['"]node:/)

      // Pacote que não existe e falta de credencial continuam fechados.
      expect((await fetch(`${host.url}/client/outra-coisa/x.js`, { headers: cookie })).status).toBe(404)
      expect((await fetch(`${host.url}/app.js`)).status).toBe(401)
      expect((await fetch(`${host.url}/client/dsh-api-gateway/browser.js`)).status).toBe(401)
    } finally {
      await host.shutdown()
    }
  })

  it('monta o manifesto de módulos do cliente em /__dsh_boot__.js', async () => {
    const host = await startOffline()
    try {
      const cookie = { cookie: `access_token=${host.token}` }

      const boot = await fetch(`${host.url}/__dsh_boot__.js`, { headers: cookie })
      expect(boot.status).toBe(200)
      expect(boot.headers.get('content-type')).toContain('javascript')
      const script = await boot.text()
      expect(script.startsWith('window.__DSH_BOOT__ = ')).toBe(true)

      const manifest = JSON.parse(script.slice('window.__DSH_BOOT__ = '.length).replace(/;\n$/, '')) as {
        version: number
        plugins: Array<{ id: string; entry: string; slots: string[] }>
        platform: Record<string, string>
        combos: Array<{ url: string; plugins: string[] }>
      }
      expect(manifest.version).toBe(1)
      // Hoje nenhum pacote declara `dsh.client` (os `ui-*` chegam na leva
      // seguinte), mas o contrato já está servido e validado pelo loader.
      expect(manifest.plugins).toEqual([])
      expect(manifest.combos).toEqual([])
      expect(typeof manifest.platform).toBe('object')

      // A entrada browser do loader é servida e não puxa builtins.
      const loader = await fetch(`${host.url}/client/dsh-client-modules/browser.js`, { headers: cookie })
      expect(loader.status).toBe(200)
      const loaderSource = await loader.text()
      expect(loaderSource).toContain('./types.js')
      expect(loaderSource).not.toMatch(/from ['"]node:|import ['"]node:/)

      // Sem cookie continua fechado.
      expect((await fetch(`${host.url}/__dsh_boot__.js`)).status).toBe(401)
    } finally {
      await host.shutdown()
    }
  })

  it('reconstrói a conversa pelo histórico persistido', async () => {
    const host = await startOffline()
    const client = createClient({ url: host.url, token: host.token })
    try {
      await client.whenOpen()
      const session = await client.call<{ id: string; title: string }>('session.create', {})
      // Título por omissão: a parte única do id, não o prefixo fixo
      // (`session-` são exactamente 8 caracteres — ver ServiceSession).
      expect(session.title).toMatch(/^Sessão [0-9a-f]{8}$/)
      await runTurn(client, session.id, 'primeira pergunta')

      const history = await client.call<{
        entries: Array<{ kind: string; text?: string }>
      }>('session.history', { sessionId: session.id })

      const kinds = history.entries.map((entry) => entry.kind)
      expect(kinds).toContain('user')
      expect(kinds).toContain('assistant')
      expect(history.entries.find((entry) => entry.kind === 'user')?.text).toBe('primeira pergunta')
      expect(history.entries.find((entry) => entry.kind === 'assistant')?.text).toContain('sem rede')

      // Id desconhecido continua a falhar com o mesmo código do resto.
      await expect(client.call('session.history', { sessionId: 'nope' })).rejects.toMatchObject({
        code: 'invalid_params',
      })
    } finally {
      client.close()
      await host.shutdown()
    }
  })

  it('cada sessão é um agente próprio, com o mesmo modelo', async () => {
    const host = await startOffline()
    const client = createClient({ url: host.url, token: host.token })
    try {
      await client.whenOpen()
      const first = await client.call<{ id: string }>('session.create', {})
      const second = await client.call<{ id: string }>('session.create', {})
      expect(second.id).not.toBe(first.id)

      const listed = await client.call<{ sessions: Array<{ id: string; modelRef: string; running: boolean }> }>(
        'session.list',
        {},
      )
      expect(listed.sessions.map((session) => session.id).sort()).toEqual([first.id, second.id].sort())
      expect(new Set(listed.sessions.map((session) => session.modelRef))).toEqual(
        new Set(['deepseek/deepseek-flash']),
      )
      expect(listed.sessions.every((session) => session.running === false)).toBe(true)

      // Um turno numa sessão não deixa a outra "a correr".
      await runTurn(client, first.id, 'primeira conversa')
      const after = await client.call<{ sessions: Array<{ running: boolean }> }>('session.list', {})
      expect(after.sessions.every((session) => session.running === false)).toBe(true)
    } finally {
      client.close()
      await host.shutdown()
    }
  })
})

describe('dsh web (CLI)', () => {
  it('arranca, anuncia URL e token, e desliga pelo sinal', async () => {
    const home = await tempDir('dsh-web-cli-')
    const workspace = await tempDir('dsh-web-cli-ws-')
    const lines: string[] = []
    const controller = new AbortController()

    const cli = runCli(
      ['web', '--port', '0', '--offline', '--home', home, '--cwd', workspace],
      { signal: controller.signal, log: (line) => lines.push(line), out: () => undefined },
    )

    // Espera o anúncio do arranque (a CLI escreve-o por `console.error`).
    const started = Date.now()
    while (!lines.some((line) => line.startsWith('dsh web em '))) {
      if (Date.now() - started > 10_000) throw new Error(`sem anúncio: ${lines.join(' | ')}`)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }

    const url = /dsh web em (\S+)/.exec(lines.join('\n'))?.[1] ?? ''
    const token = /token\s+(\S+)/.exec(lines.join('\n'))?.[1] ?? ''
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(token).toHaveLength(32)

    // A linha do browser vem pronta a clicar, com o token na query.
    expect(lines.join('\n')).toMatch(/browser\s+http:\/\/127\.0\.0\.1:\d+\/\?access_token=\S+/)

    const health = await fetch(`${url}/api/health`, { headers: { authorization: `Bearer ${token}` } })
    expect(health.status).toBe(200)

    controller.abort()
    expect(await cli).toBe(0)
  }, 30_000)

  it('recusa uma porta inválida', async () => {
    const lines: string[] = []
    const code = await runCli(['web', '--port', 'banana'], {
      log: (line) => lines.push(line),
      out: () => undefined,
    })
    expect(code).toBe(2)
    expect(lines.join('\n')).toContain('--port')
  })
})
