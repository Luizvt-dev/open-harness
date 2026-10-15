import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionFormatError } from '@open-harness/dsh-session-format'
import { Session } from '@open-harness/dsh-session'
import { SessionPersistenceError, decodeFrame, encodeFrame, loadSession, saveSession } from '@open-harness/dsh-session-persistence-jsonl'

async function tempFile(name = 'session.v4.jsonl.zstd'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-persist-'))
  return join(dir, name)
}

function sampleSession(): Session {
  const session = new Session({ id: 'session-abc', cwd: '/repo' })
  session.addUser('olá')
  session.addAssistant('oi!')
  session.addToolUse('read', { path: 'a.txt' }, 't1')
  session.addToolResult('t1', 'conteúdo do ficheiro')
  return session
}

describe('encodeFrame / decodeFrame', () => {
  it('round-tripa com Zstd e com none', async () => {
    const record = { type: 'message', role: 'user', content: [{ type: 'text', text: 'oi' }] }
    for (const compression of ['zstd', 'none'] as const) {
      const frame = await encodeFrame(record, { compression })
      expect(frame).toMatch(/^[0-9a-f]{8}\$.+/)
      expect(await decodeFrame(frame, { compression })).toEqual(record)
    }
  })

  it('o frame Zstd é comprimido (menor que o JSON cru em texto repetido)', async () => {
    const record = { type: 'message', text: 'a'.repeat(5000) }
    const frame = await encodeFrame(record, { compression: 'zstd' })
    const raw = Buffer.byteLength(JSON.stringify(record))
    // base64 infla 4/3, mas a compressão vence com folga neste conteúdo
    expect(Buffer.from(frame.split('$')[1]!, 'base64').length).toBeLessThan(raw)
  })

  it('detecta checksum divergente', async () => {
    const frame = await encodeFrame({ a: 1 }, { compression: 'none' })
    const [sum, payload] = frame.split('$') as [string, string]
    const corrupt = `00000000$${payload}`
    expect(sum).not.toBe('00000000')
    await expect(decodeFrame(corrupt, { compression: 'none' })).rejects.toThrow(/checksum/)
  })

  it('rejeita frame malformado', async () => {
    await expect(decodeFrame('sem-separador', { compression: 'none' })).rejects.toThrow(/separator/)
  })
})

describe('saveSession / loadSession', () => {
  it('round-tripa uma sessão completa e escreve cabeçalho na linha 1', async () => {
    const path = await tempFile()
    const session = sampleSession()
    await saveSession(session.toFile(), path)

    const text = await readFile(path, 'utf8')
    const lines = text.trimEnd().split('\n')
    expect(JSON.parse(lines[0]!)).toMatchObject({ type: 'session', version: 4, id: 'session-abc' })
    expect(lines).toHaveLength(5) // cabeçalho + 4 registos

    const loaded = await loadSession(path)
    expect(loaded.header.id).toBe('session-abc')
    expect(loaded.records).toEqual([...session.records])
    expect(loaded.truncated).toBe(false)
    expect(loaded.droppedFrames).toBe(0)
  })

  it('round-tripa também com compression none', async () => {
    const path = await tempFile('session.v4.jsonl')
    await saveSession(sampleSession().toFile(), path, { compression: 'none' })
    const loaded = await loadSession(path, { compression: 'none' })
    expect(loaded.records).toHaveLength(4)
  })

  it('recupera de torn-tail sem perder os registos anteriores (aceitação)', async () => {
    const path = await tempFile()
    await saveSession(sampleSession().toFile(), path)

    // Simula corte abrupto: trunca o ficheiro a meio do último frame.
    const full = await readFile(path, 'utf8')
    const cut = full.slice(0, full.length - 20)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(path, cut, 'utf8')

    const loaded = await loadSession(path)
    expect(loaded.truncated).toBe(true)
    expect(loaded.droppedFrames).toBe(1)
    // Os registos íntegros sobrevivem.
    expect(loaded.records).toHaveLength(3)
    expect(loaded.records[0]).toMatchObject({ role: 'user' })
  })

  it('descarta frames corrompidos a meio e continua', async () => {
    const path = await tempFile()
    await saveSession(sampleSession().toFile(), path)

    const lines = (await readFile(path, 'utf8')).trimEnd().split('\n')
    lines[2] = 'deadbeef$!!!!' // corrompe o 2º registo (tool_use)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(path, `${lines.join('\n')}\n`, 'utf8')

    const loaded = await loadSession(path)
    expect(loaded.droppedFrames).toBe(1)
    expect(loaded.truncated).toBe(true)
    expect(loaded.records).toHaveLength(3) // os outros 3 ficam
  })

  it('ficheiro vazio ou cabeçalho inválido é SessionPersistenceError', async () => {
    const empty = await tempFile()
    const { writeFile } = await import('node:fs/promises')
    await writeFile(empty, '', 'utf8')
    await expect(loadSession(empty)).rejects.toThrow(SessionPersistenceError)

    const bad = await tempFile()
    await writeFile(bad, '{ não é json\n', 'utf8')
    await expect(loadSession(bad)).rejects.toThrow(SessionPersistenceError)
  })

  it('migra um ficheiro antigo (v1) para o cabeçalho canónico ao carregar', async () => {
    const path = await tempFile()
    // Grava manualmente um cabeçalho v1 (sem id/parentSession/isSeeded/...).
    const { writeFile } = await import('node:fs/promises')
    const header = JSON.stringify({ type: 'session', version: 1, createdAt: 1, cwd: '/repo' })
    await writeFile(path, `${header}\n`, 'utf8')

    const loaded = await loadSession(path)
    expect(loaded.header.version).toBe(4)
    expect(loaded.header.id).toBe('')
    expect(loaded.header.agentPreset).toBe('standard')
    expect(loaded.records).toEqual([])
  })

  it('rejeita versão de sessão não suportada', async () => {
    const path = await tempFile()
    const { writeFile } = await import('node:fs/promises')
    await writeFile(path, `${JSON.stringify({ type: 'session', version: 99 })}\n`, 'utf8')
    await expect(loadSession(path)).rejects.toThrow(SessionFormatError)
  })
})
