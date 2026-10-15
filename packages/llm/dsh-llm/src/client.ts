import { LlmTimeoutError } from './errors.js'
import { withRetry, type RetryOptions } from './retry.js'
import { TokenMeter } from './tokens.js'
import type {
  ContentBlock,
  LlmAdapter,
  LlmCallOptions,
  LlmRequest,
  LlmResponse,
  LlmStreamEvent,
  StopReason,
  ToolUseBlock,
} from './types.js'

/** Estado acumulado do stream — usado pelo collector e pelo assemble. */
export interface StreamAccumulator {
  id?: string
  model?: string
  content: ContentBlock[]
  stopReason: StopReason
  usage: LlmResponse['usage']
  /** JSON parcial da tool_use activa (input_json_delta). */
  partialJson: string
  activeTool?: { id: string; name: string }
}

export function createAccumulator(): StreamAccumulator {
  return { content: [], stopReason: 'unknown', usage: { inputTokens: 0, outputTokens: 0 }, partialJson: '' }
}

function finalizeToolUse(acc: StreamAccumulator): void {
  if (!acc.activeTool) return
  let input: unknown = {}
  if (acc.partialJson.trim()) {
    try {
      input = JSON.parse(acc.partialJson)
    } catch {
      // JSON parcial inválido (stream cortado) — mantém vazio; o chamador vê is_error via stopReason.
      input = {}
    }
  }
  const block: ToolUseBlock = { type: 'tool_use', id: acc.activeTool.id, name: acc.activeTool.name, input }
  acc.content.push(block)
  acc.activeTool = undefined
  acc.partialJson = ''
}

/** Aplica um evento ao acumulador (redução pura do stream). */
export function accumulate(acc: StreamAccumulator, event: LlmStreamEvent): void {
  switch (event.type) {
    case 'message_start':
      acc.id = event.id
      acc.model = event.model
      break
    case 'text_delta':
      acc.content.push({ type: 'text', text: event.text })
      break
    case 'tool_use_start':
      finalizeToolUse(acc)
      acc.activeTool = { id: event.id, name: event.name }
      acc.partialJson = ''
      break
    case 'tool_use_delta':
      acc.partialJson += event.partialJson
      break
    case 'tool_use_stop':
      finalizeToolUse(acc)
      break
    case 'message_delta':
      acc.stopReason = event.stopReason
      acc.usage = {
        inputTokens: acc.usage.inputTokens + event.usage.inputTokens,
        outputTokens: acc.usage.outputTokens + event.usage.outputTokens,
      }
      break
    case 'message_stop':
      finalizeToolUse(acc)
      break
  }
}

/** Consome um stream e devolve a resposta montada. */
export async function collectStream(
  events: AsyncIterable<LlmStreamEvent>,
  request: LlmRequest,
): Promise<LlmResponse> {
  const acc = createAccumulator()
  for await (const event of events) accumulate(acc, event)
  return {
    id: acc.id,
    model: acc.model ?? request.model,
    // Junta `text_delta` consecutivos — o streaming parte o texto em pedaços,
    // mas a resposta final deve ter blocos de texto coesos.
    content: coalesceText(acc.content),
    stopReason: acc.stopReason,
    usage: acc.usage,
  }
}

/** Junta blocos de texto consecutivos (diagnóstico/UI). */
export function coalesceText(content: ContentBlock[]): ContentBlock[] {
  const out: ContentBlock[] = []
  for (const block of content) {
    const last = out.at(-1)
    if (block.type === 'text' && last?.type === 'text') last.text += block.text
    else out.push(block.type === 'text' ? { ...block } : block)
  }
  return out
}

export interface LlmClientOptions {
  adapter: LlmAdapter
  /** Opções de retry (parciais). */
  retry?: Partial<RetryOptions['policy']>
  /** Meter partilhado — recebe o usage de cada resposta. */
  meter?: TokenMeter
  /** Notifica após cada resposta completa. */
  onUsage?: (usage: LlmResponse['usage']) => void
}

/**
 * Cliente de alto nível sobre um adapter: retry, timeout, contabilização de
 * tokens e montagem de resposta a partir do stream.
 */
export class LlmClient {
  readonly adapter: LlmAdapter
  readonly meter: TokenMeter
  private readonly retry: Partial<RetryOptions['policy']>
  private readonly onUsage?: (usage: LlmResponse['usage']) => void

  constructor(options: LlmClientOptions) {
    this.adapter = options.adapter
    this.meter = options.meter ?? new TokenMeter()
    this.retry = options.retry ?? {}
    this.onUsage = options.onUsage
  }

  get id(): string {
    return this.adapter.id
  }

  /** Pedido completo com retry (só repete antes de qualquer evento sair). */
  async complete(request: LlmRequest, options: LlmCallOptions = {}): Promise<LlmResponse> {
    const response = await withRetry(() => this.adapter.complete(request, options), {
      policy: this.retry,
      signal: options.signal,
    })
    this.record(response.usage)
    return response
  }

  /**
   * Stream com retry parcial: erros retryáveis ANTES do primeiro evento
   * repetem (até `maxAttempts`); depois do primeiro evento o stream é
   * irrepeatível (o chamador recebe o erro em linha).
   */
  async *stream(request: LlmRequest, options: LlmCallOptions = {}): AsyncGenerator<LlmStreamEvent> {
    const maxAttempts = Math.max(1, this.retry?.maxAttempts ?? 4)
    for (let attempt = 1; ; attempt++) {
      let sawEvent = false
      try {
        const events = withTimeoutOnIterator(this.adapter.stream(request, options), options)
        for await (const event of events) {
          sawEvent = true
          yield event
        }
        return
      } catch (error) {
        if (sawEvent || attempt >= maxAttempts) throw error
        if (!isRetryableError(error)) throw error
        // relança o loop → nova tentativa completa
      }
    }
  }

  /** Stream → resposta montada, com retry e contabilização. */
  async completeFromStream(request: LlmRequest, options: LlmCallOptions = {}): Promise<LlmResponse> {
    const acc = createAccumulator()
    for await (const event of this.stream(request, options)) {
      accumulate(acc, event)
    }
    const response: LlmResponse = {
      id: acc.id,
      model: acc.model ?? request.model,
      // Mesma coesão de blocos de texto que `collectStream`.
      content: coalesceText(acc.content),
      stopReason: acc.stopReason,
      usage: acc.usage,
    }
    this.record(response.usage)
    return response
  }

  private record(usage: LlmResponse['usage']): void {
    this.meter.add(usage)
    this.onUsage?.(usage)
  }
}

/** Erro retryável? (`LlmError.retryable`, ou erro de rede genérico.) */
function isRetryableError(error: unknown): boolean {
  if (error && typeof error === 'object' && 'retryable' in error) {
    return Boolean((error as { retryable: unknown }).retryable)
  }
  return false
}

/**
 * Embrulha o stream com timeout por iteração (total) quando `timeoutMs` está
 * definido — um stream que nunca acaba não pendura o processo.
 */
async function* withTimeoutOnIterator(
  iterable: AsyncIterable<LlmStreamEvent>,
  options: LlmCallOptions,
): AsyncGenerator<LlmStreamEvent> {
  const timeoutMs = options.timeoutMs
  const iterator = iterable[Symbol.asyncIterator]()
  for (;;) {
    const next = timeoutMs
      ? await withTimeout(iterator.next(), timeoutMs, options.signal)
      : iterator.next()
    const result = await next
    if (result.done) return
    yield result.value
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new LlmTimeoutError(`LLM stream timed out after ${ms} ms`)), ms)
        signal?.addEventListener('abort', () => reject(new LlmTimeoutError('aborted')), { once: true })
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
