// ---------------------------------------------------------------------------
// Blocos de conteúdo ( formato Anthropic-like, que é o wire da DeepSeek API )
// ---------------------------------------------------------------------------

export type MediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

/** Imagem embutida (base64) — anexos de imagem observados no dsh. */
export interface ImageBlock {
  type: 'image'
  source: {
    type: 'base64'
    media_type: MediaType
    data: string
  }
}

export interface TextBlock {
  type: 'text'
  text: string
}

/** Chamada de tool pedida pelo modelo. */
export interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
}

/** Resultado de tool devolvido pela harness. */
export interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string | Array<TextBlock | ImageBlock>
  is_error?: boolean
}

export type ContentBlock = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock

export type LlmRole = 'user' | 'assistant'

export interface LlmMessage {
  role: LlmRole
  content: string | ContentBlock[]
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/** Schema JSON do input de uma tool (o wire Anthropic chama-lhe input_schema). */
export type JsonSchema = Record<string, unknown>

export interface LlmToolSpec {
  name: string
  description?: string
  input_schema: JsonSchema
}

// ---------------------------------------------------------------------------
// Pedido / resposta
// ---------------------------------------------------------------------------

export interface LlmRequest {
  model: string
  messages: LlmMessage[]
  system?: string
  tools?: LlmToolSpec[]
  maxTokens?: number
  temperature?: number
  topP?: number
  stopSequences?: string[]
}

export interface LlmUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export const EMPTY_USAGE: LlmUsage = { inputTokens: 0, outputTokens: 0 }

/** Soma dois usages (acumulador do TokenMeter). */
export function addUsage(a: LlmUsage, b: LlmUsage): LlmUsage {
  const out: LlmUsage = { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens }
  if (a.cacheReadTokens !== undefined || b.cacheReadTokens !== undefined) {
    out.cacheReadTokens = (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0)
  }
  if (a.cacheWriteTokens !== undefined || b.cacheWriteTokens !== undefined) {
    out.cacheWriteTokens = (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0)
  }
  return out
}

export type StopReason = 'end_turn' | 'max_tokens' | 'tool_use' | 'stop_sequence' | 'unknown'

export interface LlmResponse {
  id?: string
  model: string
  content: ContentBlock[]
  stopReason: StopReason
  usage: LlmUsage
}

// ---------------------------------------------------------------------------
// Eventos de streaming
// ---------------------------------------------------------------------------

export type LlmStreamEvent =
  | { type: 'message_start'; id: string; model: string }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_delta'; partialJson: string }
  | { type: 'tool_use_stop'; id: string }
  | { type: 'message_delta'; stopReason: StopReason; usage: LlmUsage }
  | { type: 'message_stop' }

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface LlmCallOptions {
  signal?: AbortSignal
  /** Timeout total do pedido em ms. */
  timeoutMs?: number
  /** Timeout sem eventos (idle) em streams. Default 300 s (observado). */
  idleTimeoutMs?: number
}

/**
 * Adapter de um provider. `stream` é a primitiva; `complete` pode ser o
 * default (consome o stream) ou nativo (endpoint não-stream).
 */
export interface LlmAdapter {
  readonly id: string
  complete(request: LlmRequest, options?: LlmCallOptions): Promise<LlmResponse>
  stream(request: LlmRequest, options?: LlmCallOptions): AsyncIterable<LlmStreamEvent>
}
