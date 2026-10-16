import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Gateway, type CallContext } from '@open-harness/dsh-api-gateway'
import {
  createRemotes,
  eventsToStream,
  resolveInside,
  type AgentEvent,
  type AgentHost,
  type CreateSessionOptions,
  type HistoryEntry,
  type SessionHandle,
  type TurnSummary,
} from '@open-harness/dsh-api-remotes'

// ---------------------------------------------------------------------------
// Host falso
// ---------------------------------------------------------------------------

const SCRIPT: AgentEvent[] = [
  { type: 'turn_start' },
  { type: 'text_delta', text: 'ola ' },
  { type: 'text_delta', text: 'mundo' },
  { type: 'turn_end', text: 'ola mundo', steps: 1, stoppedByLimit: false },
]

class FakeSession implements SessionHandle {
  readonly id: string
  readonly cwd = '/repo'
  readonly model = 'deepseek-flash'
  readonly modelRef = 'deepseek/deepseek-flash'
  readonly title = 'Sessão de teste'
  readonly createdAt = 1_700_000_000_000
  running = false
  cancelled = false
  lastText = ''

  private readonly events: AgentEvent[]

  constructor(id: string, events: AgentEvent[] = SCRIPT) {
    this.id = id
    this.events = events
  }

  async run(text: string, onEvent: (event: AgentEvent) => void, signal?: AbortSignal): Promise<TurnSummary> {
    this.lastText = text
    this.running = true
    try {
      for (const event of this.events) {
        if (signal?.aborted) break
        onEvent(event)
        await new Promise((resolve) => setTimeout(resolve, 1))
      }
      return { text: 'ola mundo', steps: 1, toolCount: 0, stoppedByLimit: false }
    } finally {
      this.running = false
    }
  }

  cancel(): void {
    this.cancelled = true
  }

  history(): HistoryEntry[] {
    return [
      { kind: 'user', text: 'olá', at: 1 },
      { kind: 'assistant', text: 'ola mundo', at: 2 },
      { kind: 'tool', id: 't1', name: 'bash', at: 3, ok: true, output: 'ok' },
    ]
  }
}

class FakeHost implements AgentHost {
  readonly sessions = new Map<string, FakeSession>()
  private counter = 0

  async create(options: CreateSessionOptions): Promise<SessionHandle> {
    const session = new FakeSession(`sess_${++this.counter}`)
    this.sessions.set(session.id, session)
    return session
  }

  get(id: string): SessionHandle | undefined {
    return this.sessions.get(id)
  }

  list(): SessionHandle[] {
    return [...this.sessions.values()]
  }

  async remove(id: string): Promise<void> {
    this.sessions.delete(id)
  }
}

function ctx(): CallContext {
  return { method: '', signal: new AbortController().signal, connection: { id: 't', send: () => undefined } }
}

function gatewayWith(host: AgentHost, cwd: string, home: string): Gateway {
  const gateway = new Gateway()
  for (const remote of createRemotes({ host, cwd, home, version: '0.1.0' })) {
    gateway.registerRemote(remote)
  }
  return gateway
}

async function collect(gateway: Gateway, method: string, params: unknown): Promise<Array<Record<string, unknown>>> {
  const events: Array<Record<string, unknown>> = []
  for await (const event of gateway.stream(method, params, ctx())) {
    events.push(event as Record<string, unknown>)
  }
  return events
}

// ---------------------------------------------------------------------------

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-remotes-'))
  dirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

describe('métodos registados', () => {
  it('expõe os remotes do plano, incluindo os stubs', () => {
    const gateway = gatewayWith(new FakeHost(), '/repo', '/home/u/.open-harness')
    expect(gateway.list()).toEqual([
      'account.profile',
      'job.cancel',
      'job.list',
      'job.run',
      'session.create',
      'session.get',
      'session.history',
      'session.list',
      'session.remove',
      'settings.get',
      'terminal.open',
      'terminal.resize',
      'terminal.write',
      'workspace.files.list',
      'workspace.files.read',
      'workspace.files.write',
      'workspace.info',
    ])
  })
})

describe('remote session', () => {
  it('cria, lista, lê e remove sessões', async () => {
    const host = new FakeHost()
    const gateway = gatewayWith(host, '/repo', '/home/u')

    const created = (await gateway.call('session.create', {}, ctx())) as { id: string; modelRef: string }
    expect(created.id).toBe('sess_1')
    expect(created.modelRef).toBe('deepseek/deepseek-flash')

    const listed = (await gateway.call('session.list', {}, ctx())) as { sessions: Array<{ id: string }> }
    expect(listed.sessions.map((s) => s.id)).toEqual(['sess_1'])

    const fetched = (await gateway.call('session.get', { sessionId: created.id }, ctx())) as { id: string }
    expect(fetched.id).toBe(created.id)

    await gateway.call('session.remove', { sessionId: created.id }, ctx())
    expect((await gateway.call('session.list', {}, ctx()))).toEqual({ sessions: [] })
  })

  it('recusa sessão desconhecida e id em falta', async () => {
    const gateway = gatewayWith(new FakeHost(), '/repo', '/home/u')
    await expect(gateway.call('session.get', { sessionId: 'nope' }, ctx())).rejects.toMatchObject({
      code: 'invalid_params',
    })
    await expect(gateway.call('session.get', {}, ctx())).rejects.toMatchObject({ code: 'invalid_params' })
  })

  it('devolve o histórico da sessão no formato do ecrã', async () => {
    const host = new FakeHost()
    const gateway = gatewayWith(host, '/repo', '/home/u')
    const created = (await gateway.call('session.create', {}, ctx())) as { id: string }

    const history = (await gateway.call('session.history', { sessionId: created.id }, ctx())) as {
      entries: Array<{ kind: string; text?: string }>
    }
    expect(history.entries.map((entry) => entry.kind)).toEqual(['user', 'assistant', 'tool'])
    expect(history.entries[0]).toMatchObject({ kind: 'user', text: 'olá' })

    await expect(gateway.call('session.history', { sessionId: 'nope' }, ctx())).rejects.toMatchObject({
      code: 'invalid_params',
    })
  })
})

describe('remote job', () => {
  it('corre um turno como stream, começando pelo job_start', async () => {
    const host = new FakeHost()
    const gateway = gatewayWith(host, '/repo', '/home/u')
    const { id } = (await gateway.call('session.create', {}, ctx())) as { id: string }

    const events = await collect(gateway, 'job.run', { sessionId: id, text: 'diz olá' })
    expect(events.map((event) => event.type)).toEqual(['job_start', 'turn_start', 'text_delta', 'text_delta', 'turn_end'])
    expect(events[0]).toMatchObject({ jobId: 'job_1', sessionId: id })
    expect(host.sessions.get(id)?.lastText).toBe('diz olá')
    expect(events.at(-1)).toMatchObject({ text: 'ola mundo' })
  })

  it('valida sessão e texto', async () => {
    const gateway = gatewayWith(new FakeHost(), '/repo', '/home/u')
    await expect(collect(gateway, 'job.run', { sessionId: 'nope', text: 'oi' })).rejects.toMatchObject({
      code: 'invalid_params',
    })
    const { id } = (await gateway.call('session.create', {}, ctx())) as { id: string }
    await expect(collect(gateway, 'job.run', { sessionId: id, text: '   ' })).rejects.toMatchObject({
      code: 'invalid_params',
    })
  })

  it('cancela o turno em curso pelo jobId', async () => {
    const host = new FakeHost()
    const gateway = gatewayWith(host, '/repo', '/home/u')
    const { id } = (await gateway.call('session.create', {}, ctx())) as { id: string }
    const session = host.sessions.get(id) as FakeSession

    const events: Array<Record<string, unknown>> = []
    const run = (async () => {
      for await (const event of gateway.stream('job.run', { sessionId: id, text: 'oi' }, ctx())) {
        events.push(event as Record<string, unknown>)
      }
    })()

    // Espera o job_start e cancela a meio do turno.
    while (!events.some((event) => event.type === 'turn_start')) {
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    await gateway.call('job.cancel', { jobId: 'job_1' }, ctx())
    await run

    expect(session.cancelled).toBe(true)
    // O turno foi interrompido: não chegou o turn_end.
    expect(events.some((event) => event.type === 'turn_end')).toBe(false)
  })

  it('lista jobs em curso e recusa cancelar um desconhecido', async () => {
    const gateway = gatewayWith(new FakeHost(), '/repo', '/home/u')
    expect(await gateway.call('job.list', {}, ctx())).toEqual({ jobs: [] })
    await expect(gateway.call('job.cancel', { jobId: 'nope' }, ctx())).rejects.toMatchObject({
      code: 'invalid_params',
    })
  })
})

describe('remote workspace.files', () => {
  it('lista, lê e escreve dentro do workspace', async () => {
    const root = tempDir()
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'index.ts'), 'export const x = 1\n', 'utf8')
    const gateway = gatewayWith(new FakeHost(), root, '/home/u')

    const listed = (await gateway.call('workspace.files.list', {}, ctx())) as {
      entries: Array<{ name: string; kind: string }>
    }
    expect(listed.entries.map((entry) => entry.name)).toEqual(['src'])
    expect(listed.entries[0]?.kind).toBe('dir')

    const nested = (await gateway.call('workspace.files.list', { path: 'src' }, ctx())) as {
      entries: Array<{ name: string; path: string }>
    }
    expect(nested.entries[0]).toMatchObject({ name: 'index.ts', path: 'src/index.ts' })

    const read = (await gateway.call('workspace.files.read', { path: 'src/index.ts' }, ctx())) as {
      content: string
      size: number
    }
    expect(read.content).toBe('export const x = 1\n')
    expect(read.size).toBe((await stat(join(root, 'src', 'index.ts'))).size)

    const written = (await gateway.call('workspace.files.write', { path: 'docs/note.md', content: 'olá' }, ctx())) as {
      ok: boolean
      bytes: number
    }
    // 'olá' são 4 bytes em UTF-8 (o `á` ocupa dois) — não 3 caracteres.
    expect(written).toMatchObject({ ok: true, bytes: 4 })
    expect(await readFile(join(root, 'docs', 'note.md'), 'utf8')).toBe('olá')
  })

  it('nunca sai do workspace', async () => {
    const root = tempDir()
    const gateway = gatewayWith(new FakeHost(), root, '/home/u')
    for (const path of ['../fora.txt', 'a/../../fora.txt', '/etc/passwd/../../x']) {
      await expect(gateway.call('workspace.files.read', { path }, ctx())).rejects.toMatchObject({
        code: 'invalid_params',
      })
    }
  })

  it('recusa ficheiro inexistente e demasiado grande', async () => {
    const root = tempDir()
    writeFileSync(join(root, 'grande.txt'), 'x'.repeat(5000), 'utf8')
    const gateway = new Gateway()
    for (const remote of createRemotes({ host: new FakeHost(), cwd: root, home: '/home/u', maxReadBytes: 1000 })) {
      gateway.registerRemote(remote)
    }
    await expect(gateway.call('workspace.files.read', { path: 'nao-existe' }, ctx())).rejects.toMatchObject({
      code: 'invalid_params',
    })
    await expect(gateway.call('workspace.files.read', { path: 'grande.txt' }, ctx())).rejects.toThrow(/too large/)
  })
})

describe('remotes auxiliares', () => {
  it('workspace.info devolve a composição do host', async () => {
    const gateway = gatewayWith(new FakeHost(), '/repo', '/home/u/.open-harness')
    const info = (await gateway.call('workspace.info', {}, ctx())) as Record<string, unknown>
    expect(info).toMatchObject({ version: '0.1.0', platform: process.platform })
    expect(String(info.cwd)).toContain('repo')
  })

  it('settings.get devolve o que o host leu', async () => {
    const gateway = new Gateway()
    for (const remote of createRemotes({
      host: new FakeHost(),
      cwd: '/repo',
      home: '/home/u',
      readSettings: () => ({ model: 'deepseek/deepseek-flash', offline: true }),
    })) {
      gateway.registerRemote(remote)
    }
    expect(await gateway.call('settings.get', {}, ctx())).toEqual({ model: 'deepseek/deepseek-flash', offline: true })
  })

  it('terminal e account respondem unavailable com o motivo', async () => {
    const gateway = gatewayWith(new FakeHost(), '/repo', '/home/u')
    await expect(gateway.call('terminal.open', {}, ctx())).rejects.toMatchObject({
      code: 'unavailable',
      message: expect.stringContaining('Fase 5'),
    })
    await expect(gateway.call('account.profile', {}, ctx())).rejects.toMatchObject({ code: 'unavailable' })
  })
})

describe('eventsToStream', () => {
  it('não perde eventos quando o produtor é mais rápido', async () => {
    const seen: number[] = []
    for await (const value of eventsToStream<number>(async (push) => {
      for (let i = 0; i < 100; i++) push(i)
    })) {
      seen.push(value)
    }
    expect(seen).toEqual(Array.from({ length: 100 }, (_, index) => index))
  })

  it('propaga a falha do produtor no ponto certo', async () => {
    const seen: number[] = []
    const failure = (async () => {
      for await (const value of eventsToStream<number>(async (push) => {
        push(1)
        push(2)
        await new Promise((resolve) => setTimeout(resolve, 1))
        throw new Error('produtor morreu')
      })) {
        seen.push(value)
      }
    })()
    await expect(failure).rejects.toThrow('produtor morreu')
    expect(seen).toEqual([1, 2])
  })
})

describe('resolveInside', () => {
  const root = join(tmpdir(), 'dsh-remotes-root')

  it('aceita caminhos dentro e recusa os que saem', () => {
    expect(resolveInside(root, 'src/index.ts')).toBe(join(root, 'src', 'index.ts'))
    expect(resolveInside(root, '')).toBe(root)
    expect(() => resolveInside(root, '../escape')).toThrow(/escapes/)
    expect(() => resolveInside(root, 'a/../../escape')).toThrow(/escapes/)
    expect(resolveInside(root, undefined)).toBe(root)
  })
})
