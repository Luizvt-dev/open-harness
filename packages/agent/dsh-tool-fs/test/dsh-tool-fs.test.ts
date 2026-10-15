import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolRegistry } from '@open-harness/dsh-tools'
import { fsTools } from '@open-harness/dsh-tool-fs'
import type { ToolContext } from '@open-harness/dsh-tools'

let dir: string
let ctx: ToolContext
let registry: ToolRegistry

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-fs-'))
  ctx = { cwd: dir }
  registry = new ToolRegistry().registerAll(fsTools())
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('tool write', () => {
  it('cria um ficheiro', async () => {
    const out = await registry.execute('write', { path: 'a.txt', content: 'olá' }, ctx)
    expect(out.ok).toBe(true)
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('olá')
  })

  it('substitui conteúdo existente', async () => {
    await registry.execute('write', { path: 'b.txt', content: '1' }, ctx)
    await registry.execute('write', { path: 'b.txt', content: '2' }, ctx)
    expect(await readFile(join(dir, 'b.txt'), 'utf8')).toBe('2')
  })

  it('resolve caminho relativo ao cwd', async () => {
    await registry.execute('write', { path: 'sub/c.txt', content: 'x' }, ctx)
    expect(await readFile(join(dir, 'sub', 'c.txt'), 'utf8')).toBe('x')
  })

  it('falha sem content', async () => {
    const out = await registry.execute('write', { path: 'z.txt' }, ctx)
    expect(out.ok).toBe(false)
  })
})

describe('tool read', () => {
  it('lê o ficheiro escrito', async () => {
    await registry.execute('write', { path: 'r.txt', content: 'conteúdo' }, ctx)
    const out = await registry.execute('read', { path: 'r.txt' }, ctx)
    expect(out).toEqual({ ok: true, result: { content: 'conteúdo' } })
  })

  it('falha em ficheiro inexistente', async () => {
    const out = await registry.execute('read', { path: 'nope.txt' }, ctx)
    expect(out.ok).toBe(false)
  })

  it('trunca ficheiros gigantes', async () => {
    const big = 'x'.repeat(600 * 1024)
    await registry.execute('write', { path: 'big.txt', content: big.slice(0, 2 * 1024 * 1024) }, ctx)
    const out = await registry.execute('read', { path: 'big.txt' }, ctx)
    expect(out.ok).toBe(true)
    if (out.ok && typeof out.result.content === 'string') {
      expect(out.result.content).toContain('[truncated')
      expect(out.result.content.length).toBeLessThan(big.length)
    }
  })
})

describe('tool edit', () => {
  it('substitui ocorrência única', async () => {
    await registry.execute('write', { path: 'e.txt', content: 'olá mundo' }, ctx)
    const out = await registry.execute(
      'edit',
      { path: 'e.txt', old_string: 'mundo', new_string: 'gente' },
      ctx,
    )
    expect(out.ok).toBe(true)
    expect(await readFile(join(dir, 'e.txt'), 'utf8')).toBe('olá gente')
  })

  it('falha se old_string não existe', async () => {
    await registry.execute('write', { path: 'e2.txt', content: 'abc' }, ctx)
    const out = await registry.execute(
      'edit',
      { path: 'e2.txt', old_string: 'zzz', new_string: 'y' },
      ctx,
    )
    expect(out.ok).toBe(false)
  })

  it('falha se old_string não é único', async () => {
    await registry.execute('write', { path: 'e3.txt', content: 'a a a' }, ctx)
    const out = await registry.execute(
      'edit',
      { path: 'e3.txt', old_string: 'a', new_string: 'b' },
      ctx,
    )
    expect(out.ok).toBe(false)
  })
})

describe('registry de fs', () => {
  it('expõe read, write e edit para o wire', () => {
    const specs = registry.toLlmTools()
    expect(specs.map((s) => s.name).sort()).toEqual(['edit', 'read', 'write'])
  })
})
