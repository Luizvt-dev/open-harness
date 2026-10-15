import {
  AnthropicAdapter,
  type AnthropicAdapterOptions,
  type AnthropicModelLimits,
  type FetchLike,
} from '@open-harness/dsh-llm'
import { DEEPSEEK_DEFAULT_MAX_TOKENS, getModel, requireModel } from './models.js'

/** Endpoint observado no dsh (API compatível com Anthropic). */
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/anthropic'
export const DEEPSEEK_ANTHROPIC_VERSION = '2023-06-01'

export interface DeepSeekAdapterOptions {
  apiKey: string
  baseUrl?: string
  fetch?: FetchLike
  /** Modelo por omissão quando o pedido não especifica. */
  defaultModel?: string
  /**
   * Validação do id do modelo. Por omissão exige o catálogo DeepSeek (falha cedo
   * para IDs inválidos). Passar `null` desactiva-a — é o que o sistema de
   * provedores faz, porque aí quem valida é o catálogo do registry.
   */
  validateModel?: ((model: string) => void) | null
  /** Limites por modelo; por omissão usa o catálogo DeepSeek. */
  limits?: (model: string) => AnthropicModelLimits | undefined
  /** Headers extra. */
  headers?: Record<string, string>
}

/** Limites do catálogo DeepSeek — a janela de contexto limita o `max_tokens`. */
function deepseekLimits(model: string): AnthropicModelLimits | undefined {
  const info = getModel(model)
  return info ? { contextWindow: info.contextWindow } : undefined
}

/**
 * Preset DeepSeek do protocolo Anthropic: fixa endpoint, versão, defaults de
 * tokens e validação do catálogo. Todo o resto é o `AnthropicAdapter`.
 */
export class DeepSeekAdapter extends AnthropicAdapter {
  constructor(options: DeepSeekAdapterOptions) {
    const base: AnthropicAdapterOptions = {
      apiKey: options.apiKey,
      id: 'deepseek',
      baseUrl: options.baseUrl ?? DEEPSEEK_BASE_URL,
      fetch: options.fetch,
      defaultModel: options.defaultModel ?? 'deepseek-flash',
      defaultMaxTokens: DEEPSEEK_DEFAULT_MAX_TOKENS,
      anthropicVersion: DEEPSEEK_ANTHROPIC_VERSION,
      label: 'DeepSeek',
      limits: options.limits ?? deepseekLimits,
    }
    if (options.headers) base.headers = options.headers
    if (options.validateModel !== null) {
      base.validateModel = options.validateModel ?? ((model: string) => void requireModel(model))
    }
    super(base)
  }
}
