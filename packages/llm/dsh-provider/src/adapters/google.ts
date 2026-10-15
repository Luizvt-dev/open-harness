// ---------------------------------------------------------------------------
// Adapter Google Gemini (`generateContent` / `streamGenerateContent?alt=sse`)
//
// Diferenças face aos outros wire formats:
//  - o system prompt é um campo separado (`systemInstruction`);
//  - `functionCall` não traz id — sintetizamos `call_<n>` e guardamos o
//    id→nome para reconstituir o `functionResponse` do lado do harness;
//  - a autenticação é o header `x-goog-api-key`.
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

export const GOOGLE_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'
export const GOOGLE_MAX_TOKENS = 8_192

export interface GoogleAdapterOptions {
  apiKey?: string
  baseUrl?: string
  fetch?: FetchLike
  defaultModel?: string
  defaultMaxTokens?: number
  label?: string
  id?: string
  headers?: Record<string, string>
  limits?(model: string): ModelLimits | undefined
}

// ---------------------------------------------------------------------------
// Mapeamento de tipos (Gemini ↔ dsh-llm)
// ---------------------------------------------------------------------------

interface GooglePart {
  text?: string
  inlineData?: { mimeType: string; data: string }
  functionCall?: { name?: string; args?: unknown }
  functionResponse?: { name: string; response: unknown }
}

interface GoogleUsage {
  promptTokenCount?: number
  candidatesTokenCount?: number
  cachedContentTokenCount?: number
  thoughtsTokenCount?: number
}

interface GoogleResponse {
  candidates?: Array<{
    content?: { parts?: GooglePart[]; role?: string }
    finishReason?: string
    index?: number
  }>
  usageMetadata?: GoogleUsage
  modelVersion?: string
}

/** Conteúdo de tool result → objecto (Gemini exige JSON em `functionResponse`). */
function toFunctionResponse(block: Extract<ContentBlock, { type: 'tool_result' }>): unknown {
  const text =
    typeof block.content === 'string'
      ? block.content
      : block.content
          .filter((part) => part.type === 'text')
          .map((part) => part.text ?? '')
          .join('\n')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }
  const response = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { output: text }
  return block.is_error ? { error: response } : response
}

/** Mapa `tool_use_id` → nome, para nomear o `functionResponse`. */
function toolNameById(messages: LlmMessage[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const message of messages) {
    if (typeof message.content === 'string') continue
    for (const block of message.content) {
      if (block.type === 'tool_use') map.set(block.id, block.name)
    }
  }
  return map
}

function toContents(messages: LlmMessage[], names: Map<string, string>): unknown[] {
  return messages.map((message) => {
    const blocks = typeof message.content === 'string' ? [{ type: 'text' as const, text: message.content }] : message.content
    const parts: GooglePart[] = []
    for (const block of blocks) {
      switch (block.type) {
        case 'text':
          parts.push({ text: block.text })
          break
        case 'image':
          parts.push({ inlineData: { mimeType: block.source.media_type, data: block.source.data } })
          break
        case 'tool_use':
          parts.push({ functionCall: { name: block.name, args: block.input ?? {} } })
          break
        case 'tool_result':
          parts.push({
            functionResponse: {
              name: names.get(block.tool_use_id) ?? block.tool_use_id,
              response: toFunctionResponse(block),
            },
          })
          break
      }
    }
    return { role: message.role === 'assistant' ? 'model' : 'user', parts }
  })
}

/** O Gemini usa JSON Schema, mas ignora chaves de metadados do harness. */
function toParameters(schema: LlmToolSpec['input_schema']): Record<string, unknown> {
  const { $schema: _schema, strict: _strict, ...rest } = schema as Record<string, unknown>
  return rest
}

function toFunctionDeclarations(tools: LlmToolSpec[] | undefined): unknown[] | undefined {
  if (!tools?.length) return undefined
  return tools.map((tool) => ({
    name: tool.name,
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    parametersJsonSchema: toParameters(tool.input_schema),
  }))
}

function fromGoogleUsage(usage: GoogleUsage | undefined): LlmUsage {
  if (!usage) return { inputTokens: 0, outputTokens: 0 }
  const out: LlmUsage = {
    inputTokens: usage.promptTokenCount ?? 0,
    outputTokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
  }
  if (usage.cachedContentTokenCount !== undefined) out.cacheReadTokens = usage.cachedContentTokenCount
  return out
}

export function fromGoogleFinishReason(reason: string | undefined): StopReason {
  switch (reason) {
    case 'STOP':
      return 'end_turn'
    case 'MAX_TOKENS':
      return 'max_tokens'
    default:
      return 'unknown'
  }
}

/** Parte Gemini → blocos dsh-llm (com id sintético para `functionCall`). */
function fromGoogleParts(parts: GooglePart[] | undefined, nextId: () => string): ContentBlock[] {
  const out: ContentBlock[] = []
  for (const part of parts ?? []) {
    if (part.text !== undefined) out.push({ type: 'text', text: part.text })
    if (part.functionCall) {
      out.push({
        type: 'tool_use',
        id: nextId(),
        name: part.functionCall.name ?? '',
        input: part.functionCall.args ?? {},
      })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class GoogleAdapter implements LlmAdapter {
  readonly id: string
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly fetchImpl: FetchLike
  private readonly defaultModel: string
  private readonly defaultMaxTokens: number
  private readonly label: string
  private readonly extraHeaders: Record<string, string>
  private readonly resolveLimits?: (model: string) => ModelLimits | undefined

  constructor(options: GoogleAdapterOptions) {
    this.id = options.id ?? 'google'
    this.apiKey = options.apiKey ?? ''
    this.baseUrl = (options.baseUrl ?? GOOGLE_BASE_URL).replace(/\/$/, '')
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.defaultModel = options.defaultModel ?? ''
    this.defaultMaxTokens = options.defaultMaxTokens ?? GOOGLE_MAX_TOKENS
    this.label = options.label ?? 'Google'
    this.extraHeaders = options.headers ?? {}
    this.resolveLimits = options.limits
  }

  async complete(request: LlmRequest, options: LlmCallOptions = {}): Promise<LlmResponse> {
    const model = this.resolveModel(request)
    const response = await this.request(this.endpoint(model, false), this.buildBody(request), options)
    const json = (await response.json()) as GoogleResponse
    const candidate = json.candidates?.[0] ?? {}
    let seq = 0
    const content = fromGoogleParts(candidate.content?.parts, () => `call_${++seq}`)
    return {
      model: json.modelVersion ?? model,
      content,
      stopReason: content.some((block) => block.type === 'tool_use')
        ? 'tool_use'
        : fromGoogleFinishReason(candidate.finishReason),
      usage: fromGoogleUsage(json.usageMetadata),
    }
  }

  async *stream(request: LlmRequest, options: LlmCallOptions = {}): AsyncGenerator<LlmStreamEvent> {
    const model = this.resolveModel(request)
    const response = await this.request(this.endpoint(model, true), this.buildBody(request), options)
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

    let started = false
    let finalized = false
    let seq = 0
    let sawTool = false
    let stopReason: StopReason = 'unknown'
    let usage: LlmUsage = { inputTokens: 0, outputTokens: 0 }
    let version = model

    const finalize = function* (): Generator<LlmStreamEvent> {
      if (finalized) return
      finalized = true
      // Como no não-stream: havendo functionCall, o turno tem tools a correr.
      yield { type: 'message_delta', stopReason: sawTool ? 'tool_use' : stopReason, usage }
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
          let chunk: GoogleResponse
          try {
            chunk = JSON.parse(event.data) as GoogleResponse
          } catch {
            continue
          }
          if (!started) {
            started = true
            version = chunk.modelVersion ?? model
            yield { type: 'message_start', id: version, model: version }
          }
          const candidate = chunk.candidates?.[0]
          for (const block of fromGoogleParts(candidate?.content?.parts, () => `call_${++seq}`)) {
            if (block.type === 'text') yield { type: 'text_delta', text: block.text }
            else if (block.type === 'tool_use') {
              sawTool = true
              yield { type: 'tool_use_start', id: block.id, name: block.name }
              yield { type: 'tool_use_delta', partialJson: JSON.stringify(block.input) }
              yield { type: 'tool_use_stop', id: '' }
            }
          }
          if (candidate?.finishReason) stopReason = fromGoogleFinishReason(candidate.finishReason)
          // O usageMetadata vem cumulativo — fica o último (o do chunk final).
          if (chunk.usageMetadata) usage = fromGoogleUsage(chunk.usageMetadata)
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

  private endpoint(model: string, stream: boolean): string {
    const action = stream ? 'streamGenerateContent?alt=sse' : 'generateContent'
    return `${this.baseUrl}/models/${encodeURIComponent(model)}:${action}`
  }

  private buildBody(request: LlmRequest): Record<string, unknown> {
    const model = this.resolveModel(request)
    const limits = this.resolveLimits?.(model) ?? {}
    const wanted = request.maxTokens ?? limits.maxTokens ?? this.defaultMaxTokens
    const body: Record<string, unknown> = {
      contents: toContents(request.messages, toolNameById(request.messages)),
    }
    if (request.system) body.systemInstruction = { parts: [{ text: request.system }] }
    const tools = toFunctionDeclarations(request.tools)
    if (tools) body.tools = [{ functionDeclarations: tools }]
    const config: Record<string, unknown> = {
      maxOutputTokens: limits.contextWindow ? Math.min(wanted, limits.contextWindow) : wanted,
    }
    if (request.temperature !== undefined) config.temperature = request.temperature
    if (request.topP !== undefined) config.topP = request.topP
    if (request.stopSequences?.length) config.stopSequences = request.stopSequences
    body.generationConfig = config
    return body
  }

  private async request(
    url: string,
    body: Record<string, unknown>,
    options: LlmCallOptions,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-goog-api-key': this.apiKey,
      ...this.extraHeaders,
    }
    let response: Response
    try {
      response = await this.fetchImpl(url, {
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
