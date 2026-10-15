import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolRegistry } from '@open-harness/dsh-tools'
import { globToRegExp, searchTools } from '@open-harness/dsh-tool-fs-search'
import type { ToolContext } from '@open-harness/dsh-tools'

let dir: string
let ctx: ToolContext
let registry: ToolRegistry

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-search-'))
  ctx = { cwd: dir }
  registry = new ToolRegistry().registerAll(searchTools())

  await mkdir(join(dir, 'src', 'nested'), { recursive: true })
  await writeFile(join(dir, 'src', 'a.ts'), 'const a = 1\nexport const b = 2\n')
  await writeFile(join(dir, 'src', 'nested', 'b.ts'), 'const c = 3\n')
  await writeFile(join(dir, 'README.md'), '# título\nconst docs = true\n')
  await writeFile(join(dir, 'src', 'binary.bin'), Buffer.from([0, 1, 2, 3]))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('globToRegExp', () => {
  it('casa * sem cruzar barra', () => {
    expect(globToRegExp('*.ts').test('a.ts')).toBe(true)
    expect(globToRegExp('*.ts').test('nested/b.ts')).toBe(false)
  })

  it('casa ** cruzando segmentos', () => {
    expect(globToRegExp('**/*.ts').test('a.ts')).toBe(true)
    expect(globToRegExp('**/*.ts').test('nested/b.ts')).toBe(true)
  })

  it('escapa caracteres especiais', () => {
    expect(globToRegExp('a.b').test('a.b')).toBe(true)
    expect(globToRegExp('a.b').test('axb')).toBe(false)
  })
})

describe('tool glob', () => {
  it('lista ficheiros por padrão', async () => {
    const out = await registry.execute('glob', { pattern: 'src/*.ts' }, ctx)
    expect(out).toEqual({ ok: true, result: { content: 'src/a.ts' } })
  })

  it('lista recursivamente com **', async () => {
    const out = await registry.execute('glob', { pattern: '**/*.ts' }, ctx)
    if (out.ok && typeof out.result.content === 'string') {
      expect(out.result.content.split('\n')).toEqual(['src/a.ts', 'src/nested/b.ts'])
    } else {
      expect.fail('glob falhou')
    }
  })

  it('devolve "no matches" quando nada casa', async () => {
    const out = await registry.execute('glob', { pattern: '**/*.jsx' }, ctx)
    expect(out).toEqual({ ok: true, result: { content: 'no matches' } })
  })
})

describe('tool grep', () => {
  it('encontra linhas com a expressão', async () => {
    const out = await registry.execute('grep', { pattern: 'const' }, ctx)
    if (out.ok && typeof out.result.content === 'string') {
      expect(out.result.content).toContain('src/a.ts:1:const a = 1')
      expect(out.result.content).toContain('README.md:2:const docs = true')
    } else {
      expect.fail('grep falhou')
    }
  })

  it('filtra por include glob', async () => {
    const out = await registry.execute('grep', { pattern: 'const', include: '*.md' }, ctx)
    if (out.ok && typeof out.result.content === 'string') {
      expect(out.result.content).toContain('README.md')
      expect(out.result.content).not.toContain('src/a.ts')
    } else {
      expect.fail('grep falhou')
    }
  })

  it('ignora binários ilegíveis e devolve no matches', async () => {
    const out = await registry.execute('grep', { pattern: 'zzzznotfound' }, ctx)
    expect(out).toEqual({ ok: true, result: { content: 'no matches' } })
  })

  it('falha se path não existe', async () => {
    const out = await registry.execute('grep', { pattern: 'x', path: 'inexistente' }, ctx)
    expect(out.ok).toBe(false)
  })
})

describe('registry de busca', () => {
  it('expõe glob e grep para o wire', () => {
    expect(registry.toLlmTools().map((s) => s.name).sort()).toEqual(['glob', 'grep'])
  })
})
