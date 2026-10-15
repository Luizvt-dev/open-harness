import { describe, expect, it } from 'vitest'
import {
  InvalidToolInputError,
  ToolExistsError,
  ToolNotAllowedError,
  ToolRegistry,
  UnknownToolError,
  type ToolDefinition,
} from '@open-harness/dsh-tools'

function echoTool(): ToolDefinition {
  return {
    name: 'echo',
    description: 'Echo back the input',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    async execute(input) {
      return { content: `echo:${String(input.text ?? '')}` }
    },
  }
}

function failTool(): ToolDefinition {
  return {
    name: 'boom',
    description: 'Always throws',
    inputSchema: { type: 'object' },
    async execute() {
      throw new Error('kaboom')
    },
  }
}

describe('ToolRegistry — registo', () => {
  it('registra e expõe nomes e specs', () => {
    const registry = new ToolRegistry().register(echoTool())
    expect(registry.names()).toEqual(['echo'])
    expect(registry.has('echo')).toBe(true)
    const specs = registry.toLlmTools()
    expect(specs).toHaveLength(1)
    expect(specs[0]).toMatchObject({ name: 'echo', description: 'Echo back the input' })
    expect(specs[0]?.input_schema).toMatchObject({ type: 'object' })
  })

  it('rejeita nomes duplicados', () => {
    const registry = new ToolRegistry().register(echoTool())
    expect(() => registry.register(echoTool())).toThrow(ToolExistsError)
  })
})

describe('ToolRegistry — restrict', () => {
  it('devolve um registry novo só com as tools permitidas', () => {
    const registry = new ToolRegistry().registerAll([echoTool(), failTool()])
    const restricted = registry.restrict(['echo'])
    expect(restricted.names()).toEqual(['echo'])
    // o original não é mutado
    expect(registry.names()).toEqual(['echo', 'boom'])
  })

  it('intersecciona com a whitelist herdada', () => {
    const registry = new ToolRegistry().registerAll([echoTool(), failTool()]).restrict(['echo'])
    const further = registry.restrict(['boom'])
    expect(further.names()).toEqual([])
  })

  it('executar tool fora da whitelist dá ToolNotAllowedError', async () => {
    const registry = new ToolRegistry().registerAll([echoTool(), failTool()]).restrict(['echo'])
    const outcome = await registry.execute('boom', {}, { cwd: '/' })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toBeInstanceOf(ToolNotAllowedError)
  })
})

describe('ToolRegistry — execução', () => {
  it('executa tool válida e devolve resultado', async () => {
    const registry = new ToolRegistry().register(echoTool())
    const outcome = await registry.execute('echo', { text: 'olá' }, { cwd: '/' })
    expect(outcome).toEqual({ ok: true, result: { content: 'echo:olá' } })
  })

  it('tool desconhecida dá UnknownToolError', async () => {
    const registry = new ToolRegistry()
    const outcome = await registry.execute('nope', {}, { cwd: '/' })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toBeInstanceOf(UnknownToolError)
  })

  it('input não-objeto dá InvalidToolInputError', async () => {
    const registry = new ToolRegistry().register(echoTool())
    for (const bad of ['texto', 42, ['a'], null]) {
      const outcome = await registry.execute('echo', bad, { cwd: '/' })
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.error).toBeInstanceOf(InvalidToolInputError)
    }
  })

  it('exceção da tool é apanhada como isError (não propaga)', async () => {
    const registry = new ToolRegistry().register(failTool())
    const outcome = await registry.execute('boom', {}, { cwd: '/' })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error.message).toContain('kaboom')
  })

  it('input undefined é tratado como objeto vazio', async () => {
    const registry = new ToolRegistry().register(echoTool())
    const outcome = await registry.execute('echo', undefined, { cwd: '/' })
    expect(outcome).toEqual({ ok: true, result: { content: 'echo:' } })
  })
})
