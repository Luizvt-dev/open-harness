import {
  LlmAbortedError,
  LlmNetworkError,
  LlmTimeoutError,
  errorFromStatus,
  type ContentBlock,
  type LlmAdapter,
  type LlmCallOptions,
  type LlmMessage,
  type LlmRequest,
  type LlmResponse,
  type LlmStreamEvent,
  type LlmToolSpec,
  type LlmUsage,
  type StopReason,
} from '@open-harness/dsh-llm'
import { SseParser } from './sse.js'
import { DEEPSEEK_DEFAULT_MAX_TOKENS, requireModel } from './models.js'

/** Endpoint observado no dsh (API compatível com Anthropic). */
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/anthropic'
export const DEEPSEEK_ANTHROPIC_VERSION = '2023-06-01'

/** Transporte injectável — `fetch` nativo por omissão, mock nos testes. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface DeepSeekAdapterOptions {
  apiKey: string
  baseUrl?: string
  fetch?: FetchLike
  /** Modelo por omissão quando o pedido não especifica. */
  defaultModel?: string
}

// ---------------------------------------------------------------------------
// Mapeamento de tipos (Anthropic-like ↔ dsh-llm)
// ---------------------------------------------------------------------------

interface AnthropicContentBlock {
  type: string
  text?: string
  source?: { type: 'base64'; media_type: string; data: string }
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: string | unknown[]
  is_error?: boolean
}

interface AnthropicMessage {
  role: LlmMessage['role']
  content: string | AnthropicContentBlock[]
}

interface AnthropicUsage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

interface AnthropicResponse {
  id: string
  model: string
  content: AnthropicContentBlock[]
  stop_reason: string | null
  usage?: AnthropicUsage
}

function toAnthropicContent(content: LlmMessage['content']): string | AnthropicContentBlock[] {
  if (typeof content === 'string') return content
  return content.map((block): AnthropicContentBlock => {
    switch (block.type) {
      case 'text':
        return { type: 'text', text: block.text }
      case 'image':
        return { type: 'image', source: block.source }
      case 'tool_use':
        return { type: 'tool_use', id: block.id, name: block.name, input: block.input }
      case 'tool_result':
        return {
          type: 'tool_result',
          tool_use_id: block.tool_use_id,
          ...(typeof block.content === 'string'
            ? { content: block.content }
            : { content: toAnthropicContent(block.content) }),
          ...(block.is_error !== undefined ? { is_error: block.is_error } : {}),
        }
    }
  })
}

function toAnthropicMessages(request: LlmRequest): AnthropicMessage[] {
  return request.messages.map((message) => ({ role: message.role, content: toAnthropicContent(message.content) }))
}

function toAnthropicTools(tools: LlmToolSpec[] | undefined): unknown[] | undefined {
  if (!tools?.length) return undefined
  return tools.map((tool) => ({
    name: tool.name,
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    input_schema: tool.input_schema,
  }))
}

function fromAnthropicUsage(usage: AnthropicUsage | undefined): LlmUsage {
  if (!usage) return { inputTokens: 0, outputTokens: 0 }
  const out: LlmUsage = {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
  }
  if (usage.cache_read_input_tokens !== undefined) out.cacheReadTokens = usage.cache_read_input_tokens
  if (usage.cache_creation_input_tokens !== undefined) out.cacheWriteTokens = usage.cache_creation_input_tokens
  return out
}

function fromStopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'end_turn':
    case 'max_tokens':
    case 'tool_use':
    case 'stop_sequence':
      return reason
    default:
      return 'unknown'
  }
}

function fromAnthropicBlock(block: AnthropicContentBlock): ContentBlock | null {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text ?? '' }
    case 'tool_use':
      return { type: 'tool_use', id: block.id ?? '', name: block.name ?? '', input: block.input ?? {} }
    case 'image':
      return block.source
        ? {
            type: 'image',
            source: {
              type: 'base64',
              media_type: block.source.media_type as 'image/png',
              data: block.source.data,
            },
          }
        : null
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Corpo do pedido
// ---------------------------------------------------------------------------

function buildBody(request: LlmRequest, stream: boolean, defaultModel: string): Record<string, unknown> {
  const model = request.model || defaultModel
  requireModel(model) // falha cedo para IDs claramente inválidos
  const maxTokens = Math.min(request.maxTokens ?? DEEPSEEK_DEFAULT_MAX_TOKENS, requireModel(model).contextWindow)
  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    messages: toAnthropicMessages(request),
    stream,
  }
  if (request.system) body.system = request.system
  const tools = toAnthropicTools(request.tools)
  if (tools) body.tools = tools
  if (request.temperature !== undefined) body.temperature = request.temperature
  if (request.topP !== undefined) body.top_p = request.topP
  if (request.stopSequences?.length) body.stop_sequences = request.stopSequences
  return body
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class DeepSeekAdapter implements LlmAdapter {
  readonly id = 'deepseek'
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly fetchImpl: FetchLike
  private readonly defaultModel: string

  constructor(options: DeepSeekAdapterOptions) {
    this.apiKey = options.apiKey
    this.baseUrl = (options.baseUrl ?? DEEPSEEK_BASE_URL).replace(/\/$/, '')
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.defaultModel = options.defaultModel ?? 'deepseek-flash'
  }

  /** POST não-stream → resposta completa. */
  async complete(request: LlmRequest, options: LlmCallOptions = {}): Promise<LlmResponse> {
    const response = await this.request('/v1/messages', buildBody(request, false, this.defaultModel), options)
    const json = (await response.json()) as AnthropicResponse
    return {
      id: json.id,
      model: json.model,
      content: (json.content ?? []).map(fromAnthropicBlock).filter((block): block is ContentBlock => block !== null),
      stopReason: fromStopReason(json.stop_reason),
      usage: fromAnthropicUsage(json.usage),
    }
  }

  /** POST stream → eventos SSE traduzidos para `LlmStreamEvent`. */
  async *stream(request: LlmRequest, options: LlmCallOptions = {}): AsyncGenerator<LlmStreamEvent> {
    const response = await this.request('/v1/messages', buildBody(request, true, this.defaultModel), options)
    const body = response.body
    if (!body) throw new LlmNetworkError('DeepSeek stream response has no body')

    const parser = new SseParser()
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let idleTimer: NodeJS.Timeout | undefined
    const idleTimeoutMs = options.idleTimeoutMs ?? 300_000

    let idleError: Error | undefined
    const armIdle = (): void => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        idleError = new LlmTimeoutError(`DeepSeek stream idle for more than ${idleTimeoutMs} ms`)
        void reader.cancel().catch(() => undefined)
      }, idleTimeoutMs)
    }

    try {
      for (;;) {
        armIdle()
        const { done, value } = await reader.read()
        if (idleTimer) clearTimeout(idleTimer)
        if (idleError) throw idleError
        if (done) break
        for (const event of parser.push(decoder.decode(value, { stream: true }))) {
          const translated = translateEvent(event)
          if (translated) yield translated
        }
      }
      const tail = parser.end()
      if (tail) {
        const translated = translateEvent(tail)
        if (translated) yield translated
      }
    } catch (error) {
      if (options.signal?.aborted || (error as Error).name === 'AbortError') {
        throw new LlmAbortedError('DeepSeek stream aborted', { cause: error })
      }
      throw error
    }
  }

  /** Envia o pedido e valida o status; mapeia erros HTTP para erros tipados. */
  private async request(path: string, body: Record<string, unknown>, options: LlmCallOptions): Promise<Response> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': DEEPSEEK_ANTHROPIC_VERSION,
    }
    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: options.signal,
      })
    } catch (error) {
      if (options.signal?.aborted) throw error
      throw new LlmNetworkError(`DeepSeek request failed: ${(error as Error).message}`, { cause: error })
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw errorFromStatus(response.status, `DeepSeek API ${response.status}: ${text.slice(0, 500)}`)
    }
    return response
  }
}

function translateEvent(event: { event: string; data: string }): LlmStreamEvent | null {
  if (!event.data || event.data === '[DONE]') return null
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(event.data) as Record<string, unknown>
  } catch {
    return null
  }
  const type = String(payload.type ?? event.event)
  switch (type) {
    case 'message_start': {
      const message = (payload.message ?? {}) as { id?: string; model?: string }
      return { type: 'message_start', id: message.id ?? '', model: message.model ?? '' }
    }
    case 'content_block_start': {
      const block = (payload.content_block ?? {}) as { type?: string; id?: string; name?: string }
      if (block.type === 'tool_use') {
        return { type: 'tool_use_start', id: block.id ?? '', name: block.name ?? '' }
      }
      return null
    }
    case 'content_block_delta': {
      const delta = (payload.delta ?? {}) as { type?: string; text?: string; partial_json?: string }
      if (delta.type === 'text_delta') return { type: 'text_delta', text: delta.text ?? '' }
      if (delta.type === 'input_json_delta') {
        return { type: 'tool_use_delta', partialJson: delta.partial_json ?? '' }
      }
      return null
    }
    case 'content_block_stop': {
      // O id da tool_use activa vem do content_block_start; aqui não há id.
      // Emitimos tool_use_stop sem id — o accumulator finaliza a tool activa.
      return { type: 'tool_use_stop', id: '' }
    }
    case 'message_delta': {
      const delta = (payload.delta ?? {}) as { stop_reason?: string | null }
      const usage = (payload.usage ?? {}) as { output_tokens?: number }
      return {
        type: 'message_delta',
        stopReason: fromStopReason(delta.stop_reason),
        usage: { inputTokens: 0, outputTokens: usage.output_tokens ?? 0 },
      }
    }
    case 'message_stop':
      return { type: 'message_stop' }
    default:
      return null
  }
}
