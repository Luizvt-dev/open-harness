import type { ModelInfo, ProviderApi } from './types.js'

/** Provedor do catálogo embutido. */
export interface BuiltinProvider {
  name: string
  api: ProviderApi
  baseURL: string
  /**
   * Variáveis de ambiente procuradas, por ordem, quando o perfil não declara
   * `apiKey`. Vazio = provedor local sem auth (ex.: Ollama).
   */
  apiKeyEnv: readonly string[]
  /** Catálogo advisory — o bloco `provider:` do perfil pode estendê-lo. */
  models: Readonly<Record<string, ModelInfo>>
}

/** Provedor por omissão quando a referência não nomeia um. */
export const DEFAULT_PROVIDER_ID = 'deepseek'

/** Modelo por omissão do harness (observado no `agent-default-model` do dsh). */
export const DEFAULT_MODEL_REF = 'deepseek/deepseek-flash'

interface ModelSpec {
  name: string
  contextWindow: number
  maxTokens: number
  cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number }
  input?: ModelInfo['input']
  toolCall?: boolean
  reasoning?: boolean
  attachment?: boolean
  temperature?: boolean
  releaseDate?: string
}

function model(id: string, spec: ModelSpec): ModelInfo {
  const info: ModelInfo = {
    id,
    name: spec.name,
    contextWindow: spec.contextWindow,
    maxTokens: spec.maxTokens,
  }
  if (spec.cost) info.cost = spec.cost
  info.input = spec.input ?? ['text']
  info.output = ['text']
  if (spec.toolCall !== undefined) info.toolCall = spec.toolCall
  if (spec.reasoning !== undefined) info.reasoning = spec.reasoning
  if (spec.attachment !== undefined) info.attachment = spec.attachment
  if (spec.temperature !== undefined) info.temperature = spec.temperature
  if (spec.releaseDate) info.releaseDate = spec.releaseDate
  return Object.freeze(info)
}

function models(...entries: ModelInfo[]): Readonly<Record<string, ModelInfo>> {
  return Object.freeze(Object.fromEntries(entries.map((entry) => [entry.id, entry])))
}

/**
 * Catálogo embutido — o análogo local ao models.dev que o OpenCode usa.
 *
 * É advisory e determinístico: funciona offline e o perfil pode sobrepor
 * qualquer entrada via `provider.<id>.models.<id>`. Os valores de contexto,
 * saída e custo vêm do models.dev (fonte que o OpenCode consome).
 */
export const BUILTIN_PROVIDERS: Readonly<Record<string, BuiltinProvider>> = Object.freeze({
  deepseek: {
    name: 'DeepSeek',
    api: 'anthropic-messages',
    baseURL: 'https://api.deepseek.com/anthropic',
    apiKeyEnv: ['DEEPSEEK_API_KEY'],
    models: models(
      model('deepseek-flash', {
        name: 'DeepSeek V4.1 Flash',
        contextWindow: 1_000_000,
        maxTokens: 393_216,
        cost: { input: 0.15, output: 0.6, cacheRead: 0.003 },
        input: ['text', 'image'],
        toolCall: true,
        reasoning: true,
        attachment: true,
        temperature: true,
        releaseDate: '2026-09-10',
      }),
      model('deepseek-v4-pro', {
        name: 'DeepSeek V4 Pro',
        contextWindow: 1_000_000,
        maxTokens: 393_216,
        cost: { input: 0.66, output: 1.98, cacheRead: 0.022 },
        toolCall: true,
        reasoning: true,
        attachment: false,
        temperature: true,
      }),
      model('deepseek-v4-flash', {
        name: 'DeepSeek V4 Flash',
        contextWindow: 1_000_000,
        maxTokens: 393_216,
        cost: { input: 0.15, output: 0.6, cacheRead: 0.003 },
        input: ['text', 'image'],
        toolCall: true,
        reasoning: true,
        attachment: true,
        temperature: true,
      }),
    ),
  },
  anthropic: {
    name: 'Anthropic',
    api: 'anthropic-messages',
    baseURL: 'https://api.anthropic.com',
    apiKeyEnv: ['ANTHROPIC_API_KEY'],
    models: models(
      model('claude-sonnet-4-5', {
        name: 'Claude Sonnet 4.5 (latest)',
        contextWindow: 200_000,
        maxTokens: 64_000,
        cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
        input: ['text', 'image', 'pdf'],
        toolCall: true,
        reasoning: true,
        attachment: true,
        temperature: true,
      }),
      model('claude-haiku-4-5', {
        name: 'Claude Haiku 4.5 (latest)',
        contextWindow: 200_000,
        maxTokens: 64_000,
        cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
        input: ['text', 'image', 'pdf'],
        toolCall: true,
        reasoning: true,
        attachment: true,
        temperature: true,
      }),
      model('claude-opus-4-6', {
        name: 'Claude Opus 4.6',
        contextWindow: 1_000_000,
        maxTokens: 128_000,
        cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
        input: ['text', 'image', 'pdf'],
        toolCall: true,
        reasoning: true,
        attachment: true,
        temperature: true,
      }),
      model('claude-sonnet-5', {
        name: 'Claude Sonnet 5',
        contextWindow: 1_000_000,
        maxTokens: 128_000,
        cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
        input: ['text', 'image', 'pdf'],
        toolCall: true,
        reasoning: true,
        attachment: true,
        temperature: false,
      }),
    ),
  },
  openai: {
    name: 'OpenAI',
    api: 'openai-chat',
    baseURL: 'https://api.openai.com/v1',
    apiKeyEnv: ['OPENAI_API_KEY'],
    models: models(
      model('gpt-5.4', {
        name: 'GPT-5.4',
        contextWindow: 1_050_000,
        maxTokens: 128_000,
        cost: { input: 2.5, output: 15, cacheRead: 0.25 },
        input: ['text', 'image', 'pdf'],
        toolCall: true,
        reasoning: true,
        attachment: true,
        temperature: true,
      }),
      model('gpt-5.4-mini', {
        name: 'GPT-5.4 mini',
        contextWindow: 400_000,
        maxTokens: 128_000,
        cost: { input: 0.75, output: 4.5, cacheRead: 0.075 },
        input: ['text', 'image'],
        toolCall: true,
        reasoning: true,
        attachment: true,
        temperature: true,
      }),
      model('gpt-5.4-nano', {
        name: 'GPT-5.4 nano',
        contextWindow: 400_000,
        maxTokens: 128_000,
        cost: { input: 0.2, output: 1.25, cacheRead: 0.02 },
        input: ['text', 'image'],
        toolCall: true,
        reasoning: true,
        attachment: true,
        temperature: true,
      }),
      model('gpt-4o', {
        name: 'GPT-4o',
        contextWindow: 128_000,
        maxTokens: 16_384,
        cost: { input: 2.5, output: 10, cacheRead: 1.25 },
        input: ['text', 'image', 'pdf'],
        toolCall: true,
        reasoning: false,
        attachment: true,
        temperature: true,
      }),
    ),
  },
  google: {
    name: 'Google',
    api: 'google-generate',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta',
    apiKeyEnv: ['GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY'],
    models: models(
      model('gemini-flash-latest', {
        name: 'Gemini Flash Latest',
        contextWindow: 1_048_576,
        maxTokens: 65_536,
        cost: { input: 0.75, output: 3.75, cacheRead: 0.075 },
        input: ['text', 'image', 'video', 'audio', 'pdf'],
        toolCall: true,
        reasoning: true,
        attachment: true,
        temperature: true,
      }),
      model('gemini-2.5-flash', {
        name: 'Gemini 2.5 Flash',
        contextWindow: 1_048_576,
        maxTokens: 65_536,
        cost: { input: 0.3, output: 2.5, cacheRead: 0.03 },
        input: ['text', 'image', 'audio', 'video', 'pdf'],
        toolCall: true,
        reasoning: true,
        attachment: true,
        temperature: true,
      }),
    ),
  },
  openrouter: {
    name: 'OpenRouter',
    api: 'openai-compatible',
    baseURL: 'https://openrouter.ai/api/v1',
    apiKeyEnv: ['OPENROUTER_API_KEY'],
    models: models(
      model('anthropic/claude-sonnet-4.5', {
        name: 'Claude Sonnet 4.5 (via OpenRouter)',
        contextWindow: 1_000_000,
        maxTokens: 64_000,
        cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
        input: ['text', 'image', 'pdf'],
        toolCall: true,
        reasoning: true,
        attachment: true,
        temperature: true,
      }),
      model('openai/gpt-4o', {
        name: 'GPT-4o (via OpenRouter)',
        contextWindow: 128_000,
        maxTokens: 16_384,
        cost: { input: 2.5, output: 10, cacheRead: 1.25 },
        input: ['text', 'image', 'pdf'],
        toolCall: true,
        attachment: true,
        temperature: true,
      }),
      model('deepseek/deepseek-chat', {
        name: 'DeepSeek Chat (via OpenRouter)',
        contextWindow: 163_840,
        maxTokens: 16_384,
        cost: { input: 0.32, output: 0.89 },
        toolCall: true,
        attachment: false,
        temperature: true,
      }),
    ),
  },
  groq: {
    name: 'Groq',
    api: 'openai-compatible',
    baseURL: 'https://api.groq.com/openai/v1',
    apiKeyEnv: ['GROQ_API_KEY'],
    models: models(
      model('llama-3.3-70b-versatile', {
        name: 'Llama 3.3 70B',
        contextWindow: 131_072,
        maxTokens: 32_768,
        cost: { input: 0.59, output: 0.79 },
        toolCall: true,
        attachment: false,
        temperature: true,
      }),
    ),
  },
  ollama: {
    name: 'Ollama',
    api: 'openai-compatible',
    baseURL: 'http://localhost:11434/v1',
    apiKeyEnv: [],
    // Catálogo aberto: os modelos existem localmente e o utilizador declara-os.
    models: models(),
  },
})

/** Ids do catálogo embutido, por ordem de declaração. */
export const BUILTIN_PROVIDER_IDS: readonly string[] = Object.freeze(Object.keys(BUILTIN_PROVIDERS))
