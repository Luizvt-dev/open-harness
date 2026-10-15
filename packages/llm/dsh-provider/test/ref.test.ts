import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ModelRefError,
  formatModelRef,
  parseModelRef,
  resolveFirstSecret,
  resolveSecret,
} from '@open-harness/dsh-provider'

describe('parseModelRef', () => {
  it('divide provedor/modelo no primeiro slash', () => {
    expect(parseModelRef('openai/gpt-5.4')).toEqual({ provider: 'openai', model: 'gpt-5.4' })
  })

  it('preserva slashes dentro do id do modelo (OpenRouter)', () => {
    expect(parseModelRef('openrouter/anthropic/claude-sonnet-4.5')).toEqual({
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4.5',
    })
  })

  it('usa o provedor default quando a referência é só o modelo', () => {
    expect(parseModelRef('deepseek-flash', { defaultProvider: 'deepseek' })).toEqual({
      provider: 'deepseek',
      model: 'deepseek-flash',
    })
  })

  it('rejeita modelo sem provedor quando não há default', () => {
    expect(() => parseModelRef('deepseek-flash')).toThrow(ModelRefError)
  })

  it('rejeita partes vazias', () => {
    expect(() => parseModelRef('')).toThrow(ModelRefError)
    expect(() => parseModelRef('   ')).toThrow(ModelRefError)
    expect(() => parseModelRef('/gpt-5.4')).toThrow(/empty provider/)
    expect(() => parseModelRef('openai/')).toThrow(/empty model/)
  })

  it('ignora espaços à volta da referência', () => {
    expect(parseModelRef('  openai/gpt-4o  ')).toEqual({ provider: 'openai', model: 'gpt-4o' })
  })

  it('formata de volta', () => {
    expect(formatModelRef({ provider: 'openrouter', model: 'openai/gpt-4o' })).toBe(
      'openrouter/openai/gpt-4o',
    )
  })
})

describe('resolveSecret', () => {
  it('devolve literais tal e qual', () => {
    expect(resolveSecret('sk-abc', {})).toBe('sk-abc')
  })

  it('resolve { env: VAR } contra o ambiente injectado', () => {
    expect(resolveSecret({ env: 'MINHA_CHAVE' }, { MINHA_CHAVE: 'sk-do-ambiente' })).toBe('sk-do-ambiente')
    expect(resolveSecret({ env: 'INEXISTENTE' }, {})).toBe('')
  })

  it('resolve { file: caminho } e ignora espaços finais', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-secret-'))
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'auth.json')
    writeFileSync(file, '  sk-de-ficheiro  \n', 'utf8')
    expect(resolveSecret({ file }, {})).toBe('sk-de-ficheiro')
  })

  it('devolve vazio quando o ficheiro não existe', () => {
    expect(resolveSecret({ file: join(tmpdir(), 'nao-existe-xyz.txt') }, {})).toBe('')
  })

  it('resolveFirstSecret devolve a primeira especificação com valor', () => {
    const specs = [{ env: 'VAZIA' }, { env: 'CHEIA' }, 'literal']
    expect(resolveFirstSecret(specs, { CHEIA: 'sk-1' })).toBe('sk-1')
    expect(resolveFirstSecret(specs, {})).toBe('literal')
    expect(resolveFirstSecret([], {})).toBe('')
  })
})
