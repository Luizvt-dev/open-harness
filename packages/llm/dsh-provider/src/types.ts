// ---------------------------------------------------------------------------
// Tipos do sistema de provedores
//
// Seguem a forma do bloco `provider:` do OpenCode: por provedor declara-se o
// protocolo (`api`), endpoint, chave (literal ou `{ env: VAR }`) e catálogo de
// modelos com metadados (contexto, custo, capacidades).
// ---------------------------------------------------------------------------

/**
 * Protocolo (wire) usado pelo provedor. É o equivalente ao campo `api` do
 * OpenCode e diz ao registry que adapter criar.
 */
export type ProviderApi =
  /** Anthropic Messages — inclui a API oficial e o endpoint Anthropic-like da DeepSeek. */
  | 'anthropic-messages'
  /** OpenAI Chat Completions oficial (usa `max_completion_tokens`). */
  | 'openai-chat'
  /** Servidores compatíveis com OpenAI: OpenRouter, Groq, Ollama, vLLM, LM Studio (usa `max_tokens`). */
  | 'openai-compatible'
  /** Google Gemini (`generateContent` / `streamGenerateContent`). */
  | 'google-generate'

/** Segredo declarável: literal, `{ env: VAR }` ou `{ file: caminho }`. */
export type ApiKeySpec = string | { env: string } | { file: string }

/** Modalidades aceites pelos metadados de modelo. */
export type Modality = 'text' | 'image' | 'audio' | 'video' | 'pdf'

/** Custo por milhão de tokens, em USD. */
export interface ModelCost {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
}

/** Metadados de um modelo — advisory: guiam limites e a listagem, não o wire. */
export interface ModelInfo {
  /** ID enviado à API (em OpenRouter contém `/`). */
  id: string
  /** Nome legível. */
  name: string
  /** Janela de contexto em tokens. */
  contextWindow: number
  /** Limite de saída em tokens. */
  maxTokens?: number
  cost?: ModelCost
  /** Modalidades de entrada/saída. */
  input?: Modality[]
  output?: Modality[]
  /** Aceita tool calls. */
  toolCall?: boolean
  /** Modelo de raciocínio (emite thought tokens). */
  reasoning?: boolean
  /** Aceita anexos (imagens/ficheiros). */
  attachment?: boolean
  /** Aceita `temperature`. */
  temperature?: boolean
  /** Data de lançamento (ISO). */
  releaseDate?: string
}

/** Entrada do catálogo de um provedor: sobrepõe campo a campo os metadados. */
export type ModelConfig = Partial<Omit<ModelInfo, 'id'>>

/** Configuração de um provedor (o bloco `provider.<id>` do perfil). */
export interface ProviderConfig {
  /** Nome legível (default: o do catálogo embutido ou o próprio id). */
  name?: string
  /** Protocolo; default: o do catálogo embutido, senão `openai-compatible`. */
  api?: ProviderApi
  /** Endpoint base. */
  baseURL?: string
  /** Chave API. Se omitida, usam-se as variáveis de ambiente do catálogo embutido. */
  apiKey?: ApiKeySpec
  /** Headers extra. */
  headers?: Record<string, string>
  /** Catálogo de modelos — estende/sobrepõe o embutido. */
  models?: Record<string, ModelConfig>
  /** Provedor desactivado (não resolve). Default `true`. */
  enabled?: boolean
  /** Rejeitar ids fora do catálogo. Default `false` (o wire dirá se o modelo existe). */
  strict?: boolean
}

/** Referência a um modelo: `provedor/modelo`. */
export interface ModelRef {
  provider: string
  model: string
}

/** Limites resolvidos de um modelo — usados para calcular limites de saída. */
export interface ModelLimits {
  contextWindow?: number
  maxTokens?: number
}

/** Provedor totalmente resolvido (catálogo embutido + config). */
export interface ResolvedProvider {
  id: string
  name: string
  api: ProviderApi
  baseURL: string
  /** Chave efectiva declarada (config), quando houver. */
  apiKey?: ApiKeySpec
  /**
   * Especificações de chave tentadas por ordem. Vazio = provedor local, sem auth.
   * As variáveis de ambiente do catálogo embutido entram aqui.
   */
  apiKeySpecs: readonly ApiKeySpec[]
  headers?: Record<string, string>
  enabled: boolean
  strict: boolean
  /** Catálogo efectivo (já fundido). */
  models: ReadonlyMap<string, ModelInfo>
  /** `true` quando existe entrada no catálogo embutido. */
  builtin: boolean
}

/** Modelo resolvido dentro de um provedor. */
export interface ResolvedModel {
  ref: ModelRef
  provider: ResolvedProvider
  model: ModelInfo
  /** `false` quando o modelo não estava no catálogo e herdou defaults conservadores. */
  known: boolean
}

/** Resumo de um provedor para listagem/UI. */
export interface ProviderSummary {
  id: string
  name: string
  api: ProviderApi
  baseURL: string
  modelCount: number
  enabled: boolean
  builtin: boolean
  /** `true` se já existe uma chave resolvida (config ou ambiente). */
  hasApiKey: boolean
  /** `false` quando é provedor local e não exige chave (ex.: Ollama). */
  requiresApiKey: boolean
}

/** Linha de modelo para listagem/UI. */
export interface ModelListing extends ModelInfo {
  provider: string
  /** Referência completa `provedor/modelo`. */
  ref: string
  /** `true` se veio do catálogo embutido (não declarado no perfil). */
  builtin: boolean
}

/** Defaults aplicados a modelos fora do catálogo. */
export const UNKNOWN_MODEL_CONTEXT_WINDOW = 128_000
export const UNKNOWN_MODEL_MAX_TOKENS = 8_192
