import { describe, expect, it } from 'vitest'
import { SchemaError, formatIssues, s, type Infer } from '@open-harness/schemastery'

const RowSchema = s.object(
  {
    plugin: s.string(),
    enabled: s.boolean().optional(),
    order: s.number().int().optional(),
  },
  { additional: 'forbid' },
)

type Row = Infer<typeof RowSchema>

describe('schemastery', () => {
  it('valida um objeto e infere o shape', () => {
    const row: Row = RowSchema.parse({ plugin: 'pkg-a', enabled: true, order: 2 })
    expect(row).toEqual({ plugin: 'pkg-a', enabled: true, order: 2 })
    expect(row.order).toBeTypeOf('number')
  })

  it('acusa chave desconhecida no modo forbid', () => {
    const result = RowSchema.validate({ plugin: 'pkg-a', typo: 1 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues[0]).toEqual({ path: 'typo', message: 'unknown key' })
  })

  it('acusa campo obrigatório ausente com caminho', () => {
    const result = RowSchema.validate({})
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues).toContainEqual({ path: 'plugin', message: 'expected string, got undefined' })
  })

  it('optional permite ausência e default preenche', () => {
    const schema = s.object({ a: s.string().optional(), b: s.string().default('fallback') })
    expect(schema.parse({})).toEqual({ b: 'fallback' })
    expect(schema.parse({ a: 'x' })).toEqual({ a: 'x', b: 'fallback' })
  })

  it('passthrough preserva chaves desconhecidas (config de plugin)', () => {
    const schema = s.object({ known: s.string() })
    expect(schema.parse({ known: 'a', extra: 42 })).toEqual({ known: 'a', extra: 42 })
  })

  it('valida arrays e caminhos indexados', () => {
    const schema = s.array(s.string())
    expect(schema.parse(['a'])).toEqual(['a'])
    const bad = schema.validate(['a', 3])
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.issues[0]?.path).toBe('[1]')
  })

  it('valida records com caminho por chave', () => {
    const schema = s.record(s.boolean())
    const bad = schema.validate({ on: true, off: 'nope' })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.issues[0]?.path).toBe('off')
  })

  it('aceita união (entrada de bundle como string ou objeto)', () => {
    const entry = s.union([s.string(), s.object({ name: s.string(), required: s.boolean().optional() })])
    expect(entry.parse('pkg')).toBe('pkg')
    expect(entry.parse({ name: 'pkg', required: false })).toEqual({ name: 'pkg', required: false })
    expect(() => entry.parse(42)).toThrow(SchemaError)
  })

  it('lança SchemaError com issues legíveis', () => {
    let thrown: unknown
    try {
      s.object({ n: s.number() }).parse({ n: 'x' })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(SchemaError)
    expect((thrown as SchemaError).message).toBe('n: expected number, got string')
    expect((thrown as SchemaError).issues).toEqual([{ path: 'n', message: 'expected number, got string' }])
  })

  it('formatIssues trata lista vazia', () => {
    expect(formatIssues([])).toBe('invalid value')
  })

  it('restrições de string/número', () => {
    expect(() => s.string({ min: 3 }).parse('ab')).toThrow(/at least 3/)
    expect(() => s.int().parse(1.5)).toThrow(/integer/)
    expect(() => s.number({ max: 10 }).parse(11)).toThrow(/<= 10/)
  })
})
