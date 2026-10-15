// ---------------------------------------------------------------------------
// Adapter OpenAI Chat Completions
//
// Cobre o endpoint oficial (`api: 'openai-chat'`, que usa
// `max_completion_tokens`) e todos os servidores compatíveis — OpenRouter,
// Groq, Ollama, vLLM, LM Studio — via `api: 'openai-compatible'` (`max_tokens`).
// ---------------------------------------------------------------------------

import {
  LlmAbortedError,
  LlmNetworkError,
  LlmTimeoutError,
  SseParser,
  errorFromStatus,
} from '@open-harness/dsh-llm'
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
} from '@open-harness/dsh-llm'
import type { ModelLimits } from '../types.js'

/** Campo usado para limitar a saída. */
export type MaxTokensField = 'max_tokens' | 'max_completion_tokens'

export const OPENAI_MAX_TOKENS = 16_384

export interface OpenAIChatAdapterOptions {
  /** Vazio = provedor local (ex.: Ollama) — o header é omitido. */
  apiKey?: string
  baseUrl: string
  fetch?: FetchLike
  defaultModel?: string
  defaultMaxTokens?: number
  label?: string
  id?: string
  headers?: Record<string, string>
  /** Campo de limite de saída (default `max_completion_tokens`). */
  maxTokensField?: MaxTokensField
  limits?(model: string): ModelLimits | undefined
}

// ---------------------------------------------------------------------------
// Mapeamento de tipos (OpenAI ↔ dsh-llm)
// ---------------------------------------------------------------------------

interface OpenAIToolCall {
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}

/** Tool call em streaming: o `index` identifica a chamada dentro do chunk. */
interface OpenAIStreamToolCall {
  index?: number
  id?: string
  function?: { name?: string; arguments?: string }
}

interface OpenAIContentPart {
  type: string
  text?: string
  image_url?: { url: string }
}

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | OpenAIContentPart[] | null
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
}

interface OpenAIUsage {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
}

function parseToolArguments(raw: string | undefined): unknown {
  if (!raw?.trim()) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

function toOpenAIContent(content: LlmMessage['content']): string | OpenAIContentPart[] {
  if (typeof content === 'string') return content
  const parts: OpenAIContentPart[] = []
  for (const block of content) {
    if (block.type === 'text') parts.push({ type: 'text', text: block.text })
    else if (block.type === 'image') {
      parts.push({
        type: 'image_url',
        image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
      })
    }
  }
  return parts
}

/** Resultado de tool → texto (o OpenAI não aceita imagens em `role: tool`). */
function toolResultText(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === 'string') return content
  return content
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('\n')
}

/**
 * Mensagens OpenAI. Um `tool_result` vira uma mensagem `role: 'tool'`
 * (uma por chamada), posicionada antes da mensagem de texto que o acompanha.
 */
function toOpenAIMessages(request: LlmRequest): OpenAIMessage[] {
  const out: OpenAIMessage[] = []
  // A Anthropic separa o system; o OpenAI é só mais uma mensagem.
  if (request.system) out.push({ role: 'system', content: request.system })
  for (const message of request.messages) {
    if (typeof message.content === 'string') {
      out.push({ role: message.role, content: message.content })
      continue
    }
    const blocks = message.content
    const toolUses = blocks.filter((block) => block.type === 'tool_use')
    const toolResults = blocks.filter((block) => block.type === 'tool_result')
    const rest = blocks.filter((block) => block.type === 'text' || block.type === 'image')

    for (const result of toolResults) {
      out.push({
        role: 'tool',
        tool_call_id: result.tool_use_id,
        content: toolResultText(result.content),
      })
    }

    if (message.role === 'assistant') {
      const text = blocks
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
      const assistant: OpenAIMessage = { role: 'assistant', content: text || null }
      if (toolUses.length) {
        assistant.tool_calls = toolUses.map((block) => ({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
        }))
      }
      out.push(assistant)
      continue
    }

    if (!rest.length) continue
    out.push({ role: 'user', content: toOpenAIContent(rest) })
  }
  return out
}

function toOpenAITools(tools: LlmToolSpec[] | undefined): unknown[] | undefined {
  if (!tools?.length) return undefined
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      parameters: tool.input_schema,
    },
  }))
}

function fromOpenAIUsage(usage: OpenAIUsage | undefined): LlmUsage {
  if (!usage) return { inputTokens: 0, outputTokens: 0 }
  const out: LlmUsage = {
    inputTokens: usage.prompt_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? 0,
  }
  const cached = usage.prompt_tokens_details?.cached_tokens
  if (cached !== undefined) out.cacheReadTokens = cached
  return out
}

export function fromOpenAIFinishReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'stop':
      return 'end_turn'
    case 'length':
      return 'max_tokens'
    case 'tool_calls':
    case 'function_call':
      return 'tool_use'
    case 'stop_sequence':
      return 'stop_sequence'
    default:
      return 'unknown'
  }
}

function fromOpenAIMessage(message: {
  content?: string | null
  tool_calls?: OpenAIToolCall[]
}): ContentBlock[] {
  const content: ContentBlock[] = []
  if (message.content) content.push({ type: 'text', text: message.content })
  for (const call of message.tool_calls ?? []) {
    content.push({
      type: 'tool_use',
      id: call.id ?? '',
      name: call.function?.name ?? '',
      input: parseToolArguments(call.function?.arguments),
    })
  }
  return content
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class OpenAIChatAdapter implements LlmAdapter {
  readonly id: string
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly fetchImpl: FetchLike
  private readonly defaultModel: string
  private readonly defaultMaxTokens: number
  private readonly label: string
  private readonly extraHeaders: Record<string, string>
  private readonly maxTokensField: MaxTokensField
  private readonly resolveLimits?: (model: string) => ModelLimits | undefined

  constructor(options: OpenAIChatAdapterOptions) {
    this.id = options.id ?? 'openai'
    this.apiKey = options.apiKey ?? ''
    this.baseUrl = (options.baseUrl ?? '').replace(/\/$/, '')
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.defaultModel = options.defaultModel ?? ''
    this.defaultMaxTokens = options.defaultMaxTokens ?? OPENAI_MAX_TOKENS
    this.label = options.label ?? 'OpenAI'
    this.extraHeaders = options.headers ?? {}
    this.maxTokensField = options.maxTokensField ?? 'max_completion_tokens'
    this.resolveLimits = options.limits
  }

  async complete(request: LlmRequest, options: LlmCallOptions = {}): Promise<LlmResponse> {
    const response = await this.request(this.buildBody(request, false), options)
    const json = (await response.json()) as {
      id?: string
      model?: string
      choices?: Array<{ message?: { content?: string | null; tool_calls?: OpenAIToolCall[] }; finish_reason?: string | null }>
      usage?: OpenAIUsage
    }
    const choice = json.choices?.[0] ?? {}
    const content = fromOpenAIMessage(choice.message ?? {})
    return {
      id: json.id,
      model: json.model ?? this.resolveModel(request),
      content,
      stopReason: content.some((block) => block.type === 'tool_use')
        ? 'tool_use'
        : fromOpenAIFinishReason(choice.finish_reason),
      usage: fromOpenAIUsage(json.usage),
    }
  }

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

    const requestedModel = this.resolveModel(request)
    let started = false
    let finalized = false
    /** Tool cujos argumentos estamos a receber (o accumulator só aceita uma activa). */
    let currentTool: number | null = null
    /** Tools ainda não iniciadas, guardadas pelo primeiro delta com id/nome. */
    const pendingTools = new Map<number, { id: string; name: string }>()
    let stopReason: StopReason = 'unknown'
    let usage: LlmUsage = { inputTokens: 0, outputTokens: 0 }
    let id = ''
    let model = requestedModel

    const finalize = function* (): Generator<LlmStreamEvent> {
      if (finalized) return
      finalized = true
      if (currentTool !== null) {
        currentTool = null
        yield { type: 'tool_use_stop', id: '' }
      }
      // Tools que nunca receberam argumentos (chamada com args vazios).
      for (const info of pendingTools.values()) {
        yield { type: 'tool_use_start', id: info.id, name: info.name }
        yield { type: 'tool_use_stop', id: '' }
      }
      pendingTools.clear()
      yield { type: 'message_delta', stopReason, usage }
      yield { type: 'message_stop' }
    }

    try {
      for (;;) {
        armIdle()
        const { done, value } = await reader.read()
        if (idleTimer) clearTimeout(idleTimer)
        if (idleError) throw idleError
        if (done) break
        for (const event of parser.push(decoder.decode(value, { stream: true }))) {
          if (!event.data || event.data === '[DONE]') continue
          let chunk: Record<string, unknown>
          try {
            chunk = JSON.parse(event.data) as Record<string, unknown>
          } catch {
            continue
          }
          if (!started) {
            started = true
            id = typeof chunk.id === 'string' ? chunk.id : ''
            model = typeof chunk.model === 'string' && chunk.model ? chunk.model : requestedModel
            yield { type: 'message_start', id, model }
          }
          const usageChunk = chunk.usage as OpenAIUsage | undefined
          if (usageChunk) usage = fromOpenAIUsage(usageChunk)
          const choice = (chunk.choices as Array<Record<string, unknown>> | undefined)?.[0]
          if (!choice) continue
          const delta = (choice.delta ?? {}) as { content?: string; tool_calls?: OpenAIStreamToolCall[] }
          if (delta.content) yield { type: 'text_delta', text: delta.content }
          for (const call of delta.tool_calls ?? []) {
            const index = call.index ?? 0
            if (call.id || call.function?.name) {
              pendingTools.set(index, {
                id: call.id ?? `call_${index + 1}`,
                name: call.function?.name ?? '',
              })
            }
            const args = call.function?.arguments
            if (!args) continue
            // O id/nome chegam no primeiro delta; os argumentos podem vir em vários.
            if (currentTool !== index) {
              if (currentTool !== null) yield { type: 'tool_use_stop', id: '' }
              const info = pendingTools.get(index) ?? { id: `call_${index + 1}`, name: '' }
              pendingTools.delete(index)
              currentTool = index
              yield { type: 'tool_use_start', id: info.id, name: info.name }
            }
            yield { type: 'tool_use_delta', partialJson: args }
          }
          if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
            stopReason = fromOpenAIFinishReason(choice.finish_reason)
          }
        }
      }
      yield* finalize()
    } catch (error) {
      if (options.signal?.aborted || (error as Error).name === 'AbortError') {
        throw new LlmAbortedError(`${this.label} stream aborted`, { cause: error })
      }
      throw error
    }
  }

  private resolveModel(request: LlmRequest): string {
    const model = request.model || this.defaultModel
    if (!model) throw new LlmNetworkError(`${this.label} adapter: no model specified`)
    return model
  }

  private buildBody(request: LlmRequest, stream: boolean): Record<string, unknown> {
    const model = this.resolveModel(request)
    const limits = this.resolveLimits?.(model) ?? {}
    const wanted = request.maxTokens ?? limits.maxTokens ?? this.defaultMaxTokens
    const body: Record<string, unknown> = {
      model,
      messages: toOpenAIMessages(request),
      stream,
      [this.maxTokensField]: limits.contextWindow ? Math.min(wanted, limits.contextWindow) : wanted,
    }
    if (stream) body.stream_options = { include_usage: true }
    const tools = toOpenAITools(request.tools)
    if (tools) body.tools = tools
    if (request.temperature !== undefined) body.temperature = request.temperature
    if (request.topP !== undefined) body.top_p = request.topP
    if (request.stopSequences?.length) body.stop = request.stopSequences
    return body
  }

  private async request(body: Record<string, unknown>, options: LlmCallOptions): Promise<Response> {
    const headers: Record<string, string> = { 'content-type': 'application/json', ...this.extraHeaders }
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`
    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
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
}
