import { describe, expect, it, vi } from 'vitest'
import {
  LlmClient,
  LlmRateLimitError,
  LlmServerError,
  LlmAbortedError,
  addUsage,
  collectStream,
  estimateImageTokens,
  estimateTokens,
  retryDelay,
  withRetry,
  type LlmAdapter,
  type LlmRequest,
  type LlmStreamEvent,
} from '@open-harness/dsh-llm'

const request: LlmRequest = { model: 'deepseek-flash', messages: [{ role: 'user', content: 'olá' }] }

describe('contabilização de tokens', () => {
  it('estima tokens de texto por comprimento', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('a'.repeat(40))).toBe(10)
  })

  it('estima tokens de imagem com downscale 3:1, patch 14px e teto 1024', () => {
    expect(estimateImageTokens(42, 42)).toBe(1) // 14×14 reduzido → 1 patch
    // 3000×3000 → reduzido 1000×1000 → 72×72 patches = 5184 → teto 1024
    expect(estimateImageTokens(3000, 3000)).toBe(1024)
  })

  it('soma usages corretamente, incluindo cache', () => {
    const total = addUsage({ inputTokens: 10, outputTokens: 5 }, { inputTokens: 3, outputTokens: 2, cacheReadTokens: 7 })
    expect(total).toEqual({ inputTokens: 13, outputTokens: 7, cacheReadTokens: 7 })
  })
})

describe('withRetry', () => {
  it('retenta erros retryáveis até ao limite', async () => {
    let calls = 0
    const fn = vi.fn(async () => {
      calls += 1
      if (calls < 3) throw new LlmServerError('boom')
      return 'ok'
    })
    const result = await withRetry(fn, { policy: { maxAttempts: 4 }, sleep: async () => undefined })
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('não retenta erros não-retryáveis', async () => {
    const fn = vi.fn(async () => {
      throw new LlmAbortedError()
    })
    await expect(withRetry(fn, { sleep: async () => undefined })).rejects.toThrow(LlmAbortedError)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('respeita o sinal de aborto', async () => {
    const controller = new AbortController()
    controller.abort()
    const fn = vi.fn(async () => 'nunca')
    await expect(withRetry(fn, { signal: controller.signal })).rejects.toThrow(LlmAbortedError)
    expect(fn).not.toHaveBeenCalled()
  })

  it('faz backoff exponencial com teto', () => {
    const policy = { baseDelayMs: 100, factor: 2, maxDelayMs: 250, jitter: 0, maxAttempts: 5 }
    expect(retryDelay(policy, 1, () => 0)).toBe(100)
    expect(retryDelay(policy, 2, () => 0)).toBe(200)
    expect(retryDelay(policy, 3, () => 0)).toBe(250) // teto
  })
})

function streamOf(events: LlmStreamEvent[]): AsyncIterable<LlmStreamEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event
    },
  }
}

describe('collectStream', () => {
  it('monta texto e uso a partir dos eventos', async () => {
    const response = await collectStream(
      streamOf([
        { type: 'message_start', id: 'm1', model: 'deepseek-flash' },
        { type: 'text_delta', text: 'olá ' },
        { type: 'text_delta', text: 'mundo' },
        { type: 'message_delta', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 4 } },
        { type: 'message_stop' },
      ]),
      request,
    )
    expect(response.id).toBe('m1')
    expect(response.content).toEqual([{ type: 'text', text: 'olá mundo' }])
    expect(response.stopReason).toBe('end_turn')
    expect(response.usage).toEqual({ inputTokens: 10, outputTokens: 4 })
  })

  it('monta tool_use a partir do JSON parcial', async () => {
    const response = await collectStream(
      streamOf([
        { type: 'tool_use_start', id: 't1', name: 'read' },
        { type: 'tool_use_delta', partialJson: '{"path":' },
        { type: 'tool_use_delta', partialJson: '"a.txt"}' },
        { type: 'tool_use_stop', id: 't1' },
        { type: 'message_stop' },
      ]),
      request,
    )
    expect(response.content).toEqual([{ type: 'tool_use', id: 't1', name: 'read', input: { path: 'a.txt' } }])
  })
})

describe('LlmClient', () => {
  const adapterWith = (impl: Partial<LlmAdapter>): LlmAdapter => ({
    id: 'test',
    complete: impl.complete ?? (async () => ({ model: 'm', content: [], stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } })),
    stream: impl.stream ?? (() => streamOf([])),
  })

  it('retenta no complete e contabiliza o usage', async () => {
    let calls = 0
    const adapter = adapterWith({
      complete: async () => {
        calls += 1
        if (calls === 1) throw new LlmRateLimitError('429')
        return { model: 'm', content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 2 } }
      },
    })
    const client = new LlmClient({ adapter, retry: { maxAttempts: 3 } })
    const response = await client.complete(request)
    expect(response.content).toEqual([{ type: 'text', text: 'ok' }])
    expect(calls).toBe(2)
    expect(client.meter.totals).toEqual({ inputTokens: 5, outputTokens: 2 })
  })

  it('não retenta stream depois do primeiro evento', async () => {
    let calls = 0
    const failing = async function* (): AsyncGenerator<LlmStreamEvent> {
      calls += 1
      yield { type: 'text_delta', text: 'parcial' }
      throw new LlmServerError('cortou a meio')
    }
    const client = new LlmClient({ adapter: adapterWith({ stream: failing }), retry: { maxAttempts: 5 } })
    await expect(client.completeFromStream(request)).rejects.toThrow('cortou a meio')
    expect(calls).toBe(1) // irrepetível após começar
  })
})
