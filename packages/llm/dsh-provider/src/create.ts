import { AnthropicAdapter, type FetchLike, type LlmAdapter } from '@open-harness/dsh-llm'
import { GoogleAdapter } from './adapters/google.js'
import { OpenAIChatAdapter } from './adapters/openai.js'
import type { ModelLimits, ResolvedProvider } from './types.js'

export interface AdapterFactoryOptions {
  /** Chave já resolvida (vazio = provedor local, sem header de auth). */
  apiKey: string
  fetch?: FetchLike
  /** Modelo usado quando o pedido não especifica. */
  defaultModel?: string
}

/**
 * Cria o adapter certo para o protocolo do provedor.
 *
 * `api` é o campo que no OpenCode é o `npm` do provider: diz qual a implementação
 * concreta por detrás da configuração declarativa.
 */
export function createProviderAdapter(provider: ResolvedProvider, options: AdapterFactoryOptions): LlmAdapter {
  const limits = (model: string): ModelLimits | undefined => {
    const info = provider.models.get(model)
    return info ? { contextWindow: info.contextWindow, maxTokens: info.maxTokens } : undefined
  }
  const common = {
    apiKey: options.apiKey,
    id: provider.id,
    baseUrl: provider.baseURL,
    fetch: options.fetch,
    label: provider.name,
    headers: provider.headers,
    limits,
    ...(options.defaultModel !== undefined ? { defaultModel: options.defaultModel } : {}),
  }
  switch (provider.api) {
    case 'anthropic-messages':
      return new AnthropicAdapter(common)
    case 'openai-chat':
      return new OpenAIChatAdapter({ ...common, maxTokensField: 'max_completion_tokens' })
    case 'openai-compatible':
      return new OpenAIChatAdapter({ ...common, maxTokensField: 'max_tokens' })
    case 'google-generate':
      return new GoogleAdapter(common)
  }
}
