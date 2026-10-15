// ---------------------------------------------------------------------------
// Adapter Anthropic Messages (protocolo)
//
// O wire da Anthropic é o que o DeepSeek expõe em `api.deepseek.com/anthropic`,
// por isso este adapter é a base comum: `DeepSeekAdapter` só fixa endpoint,
// defaults e validação de catálogo. Qualquer provedor `api: 'anthropic-messages'`
// (Anthropic oficial, proxies, bedrock-compatíveis) reutiliza exactamente este.
// ---------------------------------------------------------------------------

import { LlmAbortedError, LlmNetworkError, LlmTimeoutError, errorFromStatus } from '../errors.js'
import { SseParser } from '../sse.js'
import type {
  ContentBlock,
  FetchLike,
  LlmAdapter,
  LlmCallOptions,
  LlmMessage,
  LlmRequest,
  LlmResponse,
  LlmStreamEvent,
  LlmToolSpec,
  LlmUsage,
  StopReason,
} from '../types.js'

/** Endpoint oficial Anthropic (o `path` é acrescentado pelo adapter). */
export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com'
export const ANTHROPIC_VERSION = '2023-06-01'
export const ANTHROPIC_MAX_TOKENS = 16_384

/** Limites de um modelo, usados para calcular `max_tokens` de forma segura. */
export interface AnthropicModelLimits {
  contextWindow?: number
  maxTokens?: number
}

export interface AnthropicAdapterOptions {
  apiKey: string
  /** Identificador do adapter (default: derivado do `label`). */
  id?: string
  baseUrl?: string
  /** Path do endpoint, relativo ao `baseUrl` (default `/v1/messages`). */
  path?: string
  fetch?: FetchLike
  /** Modelo por omissão quando o pedido não especifica. */
  defaultModel?: string
  /** `max_tokens` por omissão (antes do clamp ao contexto). */
  defaultMaxTokens?: number
  /** Valor do header `anthropic-version`. */
  anthropicVersion?: string
  /** Rótulo usado nas mensagens de erro (DeepSeek, Anthropic, ...). */
  label?: string
  /** Headers extra (ex.: `anthropic-beta`). */
  headers?: Record<string, string>
  /** Validação do id do modelo — o catálogo fechado de um provedor pode usar isto. */
  validateModel?(model: string): void
  /** Limites por modelo — permitem limitar `max_tokens` ao contexto real. */
  limits?(model: string): AnthropicModelLimits | undefined
}

// ---------------------------------------------------------------------------
// Mapeamento de tipos (Anthropic ↔ dsh-llm)
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

export function fromStopReason(reason: string | null | undefined): StopReason {
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
// Adapter
// ---------------------------------------------------------------------------

/**
 * Adapter do protocolo Anthropic Messages. Não valida ids de modelo por omissão
 * (a validação é do catálogo do provedor, via `validateModel`), para aceitar
 * qualquer id que o endpoint aceite.
 */
export class AnthropicAdapter implements LlmAdapter {
  readonly id: string
  protected readonly apiKey: string
  protected readonly baseUrl: string
  protected readonly path: string
  protected readonly fetchImpl: FetchLike
  protected readonly defaultModel: string
  protected readonly defaultMaxTokens: number
  protected readonly anthropicVersion: string
  protected readonly label: string
  protected readonly extraHeaders: Record<string, string>
  private readonly validateModel?: (model: string) => void
  private readonly resolveLimits?: (model: string) => AnthropicModelLimits | undefined

  constructor(options: AnthropicAdapterOptions) {
    this.id = options.id ?? options.label?.toLowerCase() ?? 'anthropic'
    this.apiKey = options.apiKey
    this.baseUrl = (options.baseUrl ?? ANTHROPIC_BASE_URL).replace(/\/$/, '')
    this.path = options.path ?? '/v1/messages'
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.defaultModel = options.defaultModel ?? ''
    this.defaultMaxTokens = options.defaultMaxTokens ?? ANTHROPIC_MAX_TOKENS
    this.anthropicVersion = options.anthropicVersion ?? ANTHROPIC_VERSION
    this.label = options.label ?? 'Anthropic'
    this.extraHeaders = options.headers ?? {}
    this.validateModel = options.validateModel
    this.resolveLimits = options.limits
  }

  /** POST não-stream → resposta completa. */
  async complete(request: LlmRequest, options: LlmCallOptions = {}): Promise<LlmResponse> {
    const response = await this.request(this.buildBody(request, false), options)
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
    const response = await this.request(this.buildBody(request, true), options)
    const body = response.body
    if (!body) throw new LlmNetworkError(`${this.label} stream response has no body`)

    const parser = new SseParser()
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let idleTimer: NodeJS.Timeout | undefined
    const idleTimeoutMs = options.idleTimeoutMs ?? 300_000

    let idleError: Error | undefined
    const armIdle = (): void => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        idleError = new LlmTimeoutError(`${this.label} stream idle for more than ${idleTimeoutMs} ms`)
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
          const translated = this.translateEvent(event)
          if (translated) yield translated
        }
      }
      const tail = parser.end()
      if (tail) {
        const translated = this.translateEvent(tail)
        if (translated) yield translated
      }
    } catch (error) {
      if (options.signal?.aborted || (error as Error).name === 'AbortError') {
        throw new LlmAbortedError(`${this.label} stream aborted`, { cause: error })
      }
      throw error
    }
  }

  /** Resolve o modelo efectivo (pedido, depois default) — usado também pelos subclasses. */
  protected resolveModel(request: LlmRequest): string {
    const model = request.model || this.defaultModel
    if (!model) throw new LlmNetworkError(`${this.label} adapter: no model specified`)
    this.validateModel?.(model)
    return model
  }

  protected buildBody(request: LlmRequest, stream: boolean): Record<string, unknown> {
    const model = this.resolveModel(request)
    const limits = this.resolveLimits?.(model) ?? {}
    const wanted = request.maxTokens ?? limits.maxTokens ?? this.defaultMaxTokens
    const maxTokens = limits.contextWindow ? Math.min(wanted, limits.contextWindow) : wanted
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

  /** Envia o pedido e valida o status; mapeia erros HTTP para erros tipados. */
  protected async request(body: Record<string, unknown>, options: LlmCallOptions): Promise<Response> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': this.anthropicVersion,
      ...this.extraHeaders,
    }
    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}${this.path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: options.signal,
      })
    } catch (error) {
      if (options.signal?.aborted) throw error
      throw new LlmNetworkError(`${this.label} request failed: ${(error as Error).message}`, { cause: error })
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw errorFromStatus(response.status, `${this.label} API ${response.status}: ${text.slice(0, 500)}`)
    }
    return response
  }

  /** Traduz um evento SSE do protocolo Anthropic para o vocabulário do loop. */
  protected translateEvent(event: { event: string; data: string }): LlmStreamEvent | null {
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
}
