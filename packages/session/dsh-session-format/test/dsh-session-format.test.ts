import { describe, expect, it } from 'vitest'
import {
  KNOWN_VERSIONS,
  MIGRATIONS,
  SESSION_FORMAT_VERSION,
  SessionFormatError,
  isKnownVersion,
  migrateToCurrent,
  type SessionFile,
} from '@open-harness/dsh-session-format'
import { Session } from '@open-harness/dsh-session'

/** Sessão v4 completa, para round-trip. */
function v4File(): SessionFile {
  return {
    header: {
      type: 'session',
      version: 4,
      id: 'session-abc',
      createdAt: 1_700_000_000_000,
      cwd: 'C:\\Users\\Vortex\\Projeto',
      parentSession: null,
      isSeeded: false,
      delegationDepth: 0,
      agentPreset: 'standard',
    },
    records: [
      { type: 'message', timestamp: 1, role: 'user', content: [{ type: 'text', text: 'oi' }] },
      { type: 'tool_use', timestamp: 2, name: 'read', input: { path: 'a.txt' }, toolUseId: 't1' },
      { type: 'tool_result', timestamp: 3, toolUseId: 't1', output: 'conteúdo', isError: false },
    ],
  }
}

describe('catálogo de versões', () => {
  it('expõe v0..v4 e a canónica', () => {
    expect(KNOWN_VERSIONS).toEqual([0, 1, 2, 3, 4])
    expect(SESSION_FORMAT_VERSION).toBe(4)
    expect(isKnownVersion(3)).toBe(true)
    expect(isKnownVersion(9)).toBe(false)
  })

  it('cobre a cadeia v0→v4 sem saltos', () => {
    for (let v = 0; v < SESSION_FORMAT_VERSION; v++) {
      expect(MIGRATIONS.some((m) => m.from === v && m.to === v + 1)).toBe(true)
    }
  })
})

describe('migrateToCurrent', () => {
  it('devolve v4 inalterado (idempotente)', () => {
    const out = migrateToCurrent(v4File())
    expect(out).toEqual(v4File())
  })

  it('migra v0 (history de texto) para v4', () => {
    const v0 = {
      header: { type: 'session', version: 0, createdAt: 1, cwd: '/tmp' },
      history: [
        { role: 'user', text: 'olá', at: 10 },
        { role: 'assistant', text: 'oi!', at: 20 },
      ],
    }
    const out = migrateToCurrent(v0)
    expect(out.header.version).toBe(4)
    expect(out.header.agentPreset).toBe('standard')
    expect(out.header.delegationDepth).toBe(0)
    expect(out.records).toEqual([
      { type: 'message', timestamp: 10, role: 'user', content: [{ type: 'text', text: 'olá' }] },
      { type: 'message', timestamp: 20, role: 'assistant', content: [{ type: 'text', text: 'oi!' }] },
    ])
  })

  it('migra v1 (id/parentSession) e v3 (toolUseId em tool_result)', () => {
    const v1 = {
      header: { type: 'session', version: 1, createdAt: 1, cwd: '/tmp' },
      records: [{ type: 'tool_result', timestamp: 2, id: 't9', output: 'x' }],
    }
    const out = migrateToCurrent(v1)
    expect(out.header.id).toBe('') // preenchido na migração v1→v2
    expect(out.header.parentSession).toBeNull()
    expect(out.records[0]).toMatchObject({ type: 'tool_result', toolUseId: 't9' })
  })

  it('rejeita versão desconhecida e versão futura', () => {
    expect(() => migrateToCurrent({ header: { type: 'session', version: 99 }, records: [] })).toThrow(
      SessionFormatError,
    )
  })
})

describe('Session', () => {
  it('constrói cabeçalho v4 com defaults', () => {
    const session = new Session({ id: 'session-x', cwd: '/repo' })
    expect(session.header).toMatchObject({
      type: 'session',
      version: 4,
      id: 'session-x',
      agentPreset: 'standard',
      delegationDepth: 0,
      isSeeded: false,
      parentSession: null,
    })
    expect(typeof session.header.createdAt).toBe('number')
  })

  it('acumula registos via helpers e round-tripa por toFile', () => {
    const session = new Session({ id: 'session-x', cwd: '/repo' })
    session.addUser('olá')
    session.addAssistant('oi')
    session.addToolUse('read', { path: 'a.txt' }, 't1')
    session.addToolResult('t1', 'conteúdo')
    session.addSummary('conversa curta')
    session.addCheckpoint({ step: 1 })

    expect(session.length).toBe(6)
    expect(session.records.map((r) => r.type)).toEqual(['message', 'message', 'tool_use', 'tool_result', 'summary', 'checkpoint'])
    expect(session.records[0]).toMatchObject({ role: 'user', content: [{ type: 'text', text: 'olá' }] })
    expect(session.records[3]).toMatchObject({ toolUseId: 't1', isError: false })

    // round-trip → migração devolve igual (já é v4)
    const file = session.toFile()
    expect(migrateToCurrent(file)).toEqual(file)

    // e reconstrói uma sessão equivalente
    const rebuilt = Session.fromFile(file.header, file.records)
    expect(rebuilt.length).toBe(6)
    expect(rebuilt.toFile()).toEqual(file)
  })
})
