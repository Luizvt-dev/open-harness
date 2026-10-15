import { describe, expect, it } from 'vitest'
import {
  BUILTIN_PROVIDER_IDS,
  DEFAULT_MODEL_REF,
  MissingApiKeyError,
  ProviderDisabledError,
  ProviderRegistry,
  UnknownModelError,
  UnknownProviderError,
} from '@open-harness/dsh-provider'

function registry(options: ConstructorParameters<typeof ProviderRegistry>[0] = {}): ProviderRegistry {
  return new ProviderRegistry(options)
}

describe('catálogo embutido', () => {
  it('conhece os provedores observados', () => {
    expect(BUILTIN_PROVIDER_IDS).toEqual(['deepseek', 'anthropic', 'openai', 'google', 'openrouter', 'groq', 'ollama'])
    expect(registry().ids()).toEqual([...BUILTIN_PROVIDER_IDS])
  })

  it('traz metadados de contexto, saída, tools e custo', () => {
    const model = registry().resolve('deepseek/deepseek-flash')
    expect(model.known).toBe(true)
    expect(model.model.name).toBe('DeepSeek V4.1 Flash')
    expect(model.model.contextWindow).toBe(1_000_000)
    expect(model.model.maxTokens).toBe(393_216)
    expect(model.model.toolCall).toBe(true)
    expect(model.model.reasoning).toBe(true)
    expect(model.model.input).toContain('image')
    expect(model.model.cost?.input).toBe(0.15)
  })

  it('sabe qual a variável de ambiente de cada provedor', () => {
    const provider = registry().get('openai')
    expect(provider?.api).toBe('openai-chat')
    expect(provider?.baseURL).toBe('https://api.openai.com/v1')
    expect(provider?.apiKeySpecs).toEqual([{ env: 'OPENAI_API_KEY' }])
  })

  it('trata o Ollama como provedor local, sem chave', () => {
    const provider = registry().get('ollama')
    expect(provider?.apiKeySpecs).toEqual([])
    expect(provider?.models.size).toBe(0)
  })
})

describe('resolve', () => {
  it('aceita a referência curta com o provedor default', () => {
    expect(registry().resolve('deepseek-flash').ref).toEqual({ provider: 'deepseek', model: 'deepseek-flash' })
    expect(registry().defaultRef()).toBe(DEFAULT_MODEL_REF)
  })

  it('mantém o slash dentro do id do modelo', () => {
    const resolved = registry().resolve('openrouter/deepseek/deepseek-chat')
    expect(resolved.ref).toEqual({ provider: 'openrouter', model: 'deepseek/deepseek-chat' })
    expect(resolved.known).toBe(true)
  })

  it('falha com o provedor todo listado quando o id não existe', () => {
    expect(() => registry().resolve('openaai/gpt-4o')).toThrow(UnknownProviderError)
    try {
      registry().resolve('openaai/gpt-4o')
    } catch (error) {
      expect((error as UnknownProviderError).providerId).toBe('openaai')
      expect((error as UnknownProviderError).known).toContain('openai')
    }
  })

  it('aceita modelo fora do catálogo com defaults conservadores', () => {
    const resolved = registry().resolve('ollama/llama3.1:8b')
    expect(resolved.known).toBe(false)
    expect(resolved.model.contextWindow).toBe(128_000)
    expect(resolved.model.maxTokens).toBe(8_192)
    expect(resolved.model.toolCall).toBeUndefined()
  })

  it('com strict rejeita modelo fora do catálogo', () => {
    const strict = registry({ providers: { openai: { strict: true } } })
    expect(() => strict.resolve('openai/gpt-nao-existe')).toThrow(UnknownModelError)
    try {
      strict.resolve('openai/gpt-nao-existe')
    } catch (error) {
      expect((error as UnknownModelError).known).toContain('gpt-5.4')
    }
  })

  it('falha quando o provedor está desligado', () => {
    const off = registry({ providers: { openai: { enabled: false } } })
    expect(() => off.resolve('openai/gpt-5.4')).toThrow(ProviderDisabledError)
    expect(off.listProviders().find((p) => p.id === 'openai')?.enabled).toBe(false)
    expect(off.listModels().some((m) => m.provider === 'openai')).toBe(false)
  })
})

describe('configure', () => {
  it('estende o catálogo do provedor com modelos do perfil', () => {
    const withCustom = registry({
      env: { OPENAI_API_KEY: 'sk-test' },
      providers: { openai: { models: { 'gpt-5.4': { contextWindow: 200_000 }, 'modelo-local': {} } } },
    })
    const merged = withCustom.resolve('openai/gpt-5.4')
    expect(merged.model.contextWindow).toBe(200_000)
    // o resto da entrada embutida mantém-se
    expect(merged.model.name).toBe('GPT-5.4')
    expect(merged.model.maxTokens).toBe(128_000)

    const added = withCustom.resolve('openai/modelo-local')
    expect(added.known).toBe(true)
    expect(added.model.name).toBe('modelo-local')
  })

  it('permite declarar provedores novos (protocolo, endpoint e chave)', () => {
    const custom = registry({
      env: { MINHA_CHAVE: 'sk-minha' },
      providers: {
        interno: {
          name: 'LLM interno',
          api: 'openai-compatible',
          baseURL: 'http://llm.interno:8000/v1',
          apiKey: { env: 'MINHA_CHAVE' },
          models: { 'modelo-7b': { name: 'Modelo 7B', contextWindow: 32_000 } },
        },
      },
    })
    const provider = custom.get('interno')
    expect(provider?.builtin).toBe(false)
    expect(provider?.name).toBe('LLM interno')
    expect(provider?.models.get('modelo-7b')?.contextWindow).toBe(32_000)
    expect(custom.has('interno/modelo-7b')).toBe(true)
  })

  it('funde configuração acumulada por camadas', () => {
    const layered = registry()
      .configure({ openai: { apiKey: { env: 'A' } } })
      .configure({ openai: { strict: true } })
    const provider = layered.get('openai')
    expect(provider?.strict).toBe(true)
    expect(provider?.apiKey).toEqual({ env: 'A' })
  })

  it('ignora o catálogo embutido quando pedido', () => {
    const bare = new ProviderRegistry({ includeBuiltin: false, providers: { meu: { baseURL: 'http://x' } } })
    expect(bare.ids()).toEqual(['meu'])
  })
})

describe('chaves', () => {
  it('usa a variável de ambiente do catálogo embutido', () => {
    const withKey = registry({ env: { DEEPSEEK_API_KEY: 'sk-ds' } })
    expect(withKey.listProviders().find((p) => p.id === 'deepseek')?.hasApiKey).toBe(true)
    expect(withKey.adapterFor('deepseek/deepseek-flash').id).toBe('deepseek')
  })

  it('reporta a variável em falta em vez de falhar em silêncio', () => {
    try {
      registry({ env: {} }).adapterFor('openai/gpt-5.4')
      expect.unreachable('devia ter lançado')
    } catch (error) {
      expect(error).toBeInstanceOf(MissingApiKeyError)
      expect((error as MissingApiKeyError).message).toContain('OPENAI_API_KEY')
    }
  })

  it('marca provedores locais como sem chave exigida', () => {
    const summary = registry({ env: {} }).listProviders().find((p) => p.id === 'ollama')
    expect(summary?.requiresApiKey).toBe(false)
    expect(summary?.hasApiKey).toBe(false)
  })

  it('ordena as especificações e escolhe a primeira resolvida', () => {
    const google = registry({ env: { GEMINI_API_KEY: 'sk-gemini' } })
    expect(google.get('google')?.apiKeySpecs).toEqual([
      { env: 'GOOGLE_API_KEY' },
      { env: 'GOOGLE_GENERATIVE_AI_API_KEY' },
      { env: 'GEMINI_API_KEY' },
    ])
    expect(google.adapterFor('google/gemini-2.5-flash').id).toBe('google')
  })
})

describe('listagens', () => {
  it('resume provedores com protocolo, chave e nº de modelos', () => {
    const openai = registry({ env: { OPENAI_API_KEY: 'sk' } }).listProviders().find((p) => p.id === 'openai')
    expect(openai).toMatchObject({
      api: 'openai-chat',
      builtin: true,
      enabled: true,
      hasApiKey: true,
      requiresApiKey: true,
      modelCount: 4,
    })
  })

  it('lista modelos com a referência pronta a usar', () => {
    const models = registry().listModels({ provider: 'groq' })
    expect(models).toHaveLength(1)
    expect(models[0]).toMatchObject({
      ref: 'groq/llama-3.3-70b-versatile',
      provider: 'groq',
      toolCall: true,
      contextWindow: 131_072,
    })
  })

  it('filtra por texto em id, nome e provedor', () => {
    const found = registry().listModels({ search: 'claude sonnet' })
    expect(found.map((model) => model.ref)).toContain('anthropic/claude-sonnet-4-5')
    // O mesmo modelo existe também via OpenRouter — o filtro é por texto livre.
    expect(found.map((model) => model.ref)).toContain('openrouter/anthropic/claude-sonnet-4.5')
    expect(registry().listModels({ search: 'gpt-4o' }).map((m) => m.ref)).toContain('openai/gpt-4o')
  })

  it('sinaliza os modelos declarados no perfil como não-embutidos', () => {
    const custom = registry({ providers: { openai: { models: { 'modelo-novo': {} } } } })
    const listed = custom.listModels({ provider: 'openai' })
    expect(listed.find((m) => m.id === 'gpt-4o')?.builtin).toBe(true)
    expect(listed.find((m) => m.id === 'modelo-novo')?.builtin).toBe(false)
  })
})
