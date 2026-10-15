import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import {
  encodeWorkspace,
  newSessionId,
  sessionDir,
  sessionFileName,
  sessionFilePath,
} from '@open-harness/dsh-session'

describe('encodeWorkspace', () => {
  it('troca \\ e : por - (regra observada no dsh)', () => {
    expect(encodeWorkspace('C:\\Users\\Vortex\\Downloads\\Teste\\')).toBe('C--Users-Vortex-Downloads-Teste-')
    expect(encodeWorkspace('/home/user/repo')).toBe('/home/user/repo') // POSIX intacto
    expect(encodeWorkspace('C:/Users/Vortex')).toBe('C-/Users/Vortex') // só o : é mapeado
  })
})

describe('sessionFileName', () => {
  it('inclui versão e extensão Zstd', () => {
    expect(sessionFileName(4)).toBe('session.v4.jsonl.zstd')
    expect(sessionFileName(4, 'none')).toBe('session.v4.jsonl')
  })
})

describe('caminhos de sessão', () => {
  it('monta <home>/sessions/<workspace>/session-<id>', () => {
    const dir = sessionDir('/home/v/.open-harness', 'C:\\Users\\Vortex\\Repo', 'session-abc')
    expect(dir).toBe(join('/home/v/.open-harness', 'sessions', 'C--Users-Vortex-Repo', 'session-abc'))
  })

  it('sessionFilePath anexa o ficheiro com versão e compressor', () => {
    const path = sessionFilePath({
      home: '/home/v/.open-harness',
      cwd: '/repo',
      sessionId: 'session-abc',
      version: 4,
      compression: 'zstd',
    })
    expect(path).toBe(join('/home/v/.open-harness', 'sessions', '/repo', 'session-abc', 'session.v4.jsonl.zstd'))
  })
})

describe('newSessionId', () => {
  it('gera ids únicos com prefixo session-', () => {
    const a = newSessionId()
    const b = newSessionId()
    expect(a).toMatch(/^session-[0-9a-f]{16}$/)
    expect(a).not.toBe(b)
  })
})
