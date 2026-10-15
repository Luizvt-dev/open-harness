import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { FetchLike } from '@open-harness/dsh-llm'
import { MissingApiKeyError, ProviderRegistry } from '@open-harness/dsh-provider'
import { createAgentService } from '@open-harness/dsh-agent'

/** Resposta do OpenAI para um turno: texto e `finish_reason: stop`. */
function openaiTurn(text: string): Response {
  return new Response(
    JSON.stringify({
      id: 'chatcmpl-1',
      model: 'gpt-4o',
      choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 4, completion_tokens: 2 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

interface Captured {
  url: string
  body: Record<string, unknown>
}

function recorder(response: () => Response): { fetch: FetchLike; calls: Captured[] } {
  const calls: Captured[] = []
  const fetch: FetchLike = async (input, init) => {
    calls.push({ url: input, body: JSON.parse(String(init?.body)) as Record<string, unknown> })
    return response()
  }
  return { fetch, calls }
}

function home(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-agent-'))
}

describe('createAgentService (multi-provedor)', () => {
  it('resolve a referência provedor/modelo para o id de wire', () => {
    const { fetch } = recorder(() => openaiTurn('oi'))
    const registry = new ProviderRegistry({ env: { OPENAI_API_KEY: 'sk' }, fetch })
    const service = createAgentService({ registry, model: 'openai/gpt-4o', homeDir: home() })

    expect(service.registry).toBe(registry)
    expect(service.modelRef).toBe('openai/gpt-4o')
    // O provider recebe só o id do modelo — o prefixo é do registry.
    expect(service.model).toBe('gpt-4o')
  })

  it('mantém a referência curta no provedor default (compatibilidade)', () => {
    const { fetch } = recorder(() => openaiTurn('oi'))
    const registry = new ProviderRegistry({ env: { DEEPSEEK_API_KEY: 'sk' }, fetch })
    const service = createAgentService({ registry, model: 'deepseek-flash', homeDir: home() })
    expect(service.modelRef).toBe('deepseek/deepseek-flash')
    expect(service.model).toBe('deepseek-flash')
  })

  it('corre um turno de ponta a ponta pelo adapter do provedor', async () => {
    const { fetch, calls } = recorder(() => openaiTurn('README escrito'))
    const registry = new ProviderRegistry({
      env: { OPENAI_API_KEY: 'sk-o' },
      fetch,
      providers: { openai: { models: { 'gpt-4o': { maxTokens: 4_096 } } } },
    })
    const service = createAgentService({ registry, model: 'openai/gpt-4o', homeDir: home() })

    const outcome = await service.run('olá')

    expect(calls[0]?.url).toBe('https://api.openai.com/v1/chat/completions')
    // O limite de saída vem do catálogo resolvido (merge do perfil).
    expect(calls[0]?.body.max_completion_tokens).toBe(4_096)
    expect(outcome.text).toContain('README escrito')
    expect(outcome.steps).toBe(1)
  })

  it('propaga o erro de chave em falta na criação do serviço', () => {
    const registry = new ProviderRegistry({ env: {} })
    expect(() => createAgentService({ registry, model: 'openai/gpt-4o', homeDir: home() })).toThrow(
      MissingApiKeyError,
    )
  })

  it('aceita um provedor novo declarado no perfil (alias `provider` do OpenCode)', () => {
    const service = createAgentService({
      provider: {
        interno: {
          api: 'openai-compatible',
          baseURL: 'http://llm.interno:8000/v1',
          apiKey: 'sk-interno',
          models: { 'modelo-7b': { name: 'Modelo 7B', contextWindow: 1_000 } },
        },
      },
      model: 'interno/modelo-7b',
      homeDir: home(),
    })
    expect(service.modelRef).toBe('interno/modelo-7b')
    expect(service.model).toBe('modelo-7b')
    expect(service.registry.get('interno')?.models.get('modelo-7b')?.contextWindow).toBe(1_000)
  })
})
