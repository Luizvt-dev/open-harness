import { describe, expect, it } from 'vitest'
import {
  LlmRateLimitError,
  LlmServerError,
  collectStream,
  type LlmRequest,
  type LlmStreamEvent,
} from '@open-harness/dsh-llm'
import {
  DEEPSEEK_BASE_URL,
  DeepSeekAdapter,
  SseParser,
  requireModel,
  type FetchLike,
} from '@open-harness/dsh-llm-deepseek'

const request: LlmRequest = {
  model: 'deepseek-flash',
  system: 'seja breve',
  messages: [
    { role: 'user', content: 'olá' },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't1', name: 'read', input: { path: 'a.txt' } }],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'conteúdo' }] },
  ],
}

function sseBody(lines: string[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line))
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function captureFetch(reply: () => Response | Promise<Response>): { fetch: FetchLike; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = []
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init: init ?? {} })
    return reply()
  }
  return { fetch, calls }
}

describe('catálogo de modelos', () => {
  it('expõe flash e v4-pro', () => {
    expect(requireModel('deepseek-flash').vision).toBe(true)
    expect(requireModel('deepseek-v4-pro').vision).toBe(false)
    expect(() => requireModel('nao-existe')).toThrow(/unknown DeepSeek model/)
  })
})

describe('SseParser', () => {
  it('agrupa linhas em eventos e tolera CRLF, comentários e data multilinha', () => {
    const parser = new SseParser()
    const events = parser.push(
      ': keep-alive\r\nevent: message_start\r\ndata: {"a":1}\r\n\r\ndata: linha1\ndata: linha2\n\n',
    )
    expect(events).toEqual([
      { event: 'message_start', data: '{"a":1}' },
      { event: 'message', data: 'linha1\nlinha2' },
    ])
  })

  it('divide eventos correctos entre chunks (boundary no meio)', () => {
    const parser = new SseParser()
    expect(parser.push('data: {"type":"tex')).toEqual([])
    expect(parser.push('t_delta","text":"oi"}\n\n')).toEqual([{ event: 'message', data: '{"type":"text_delta","text":"oi"}' }])
  })
})

describe('DeepSeekAdapter.complete', () => {
  it('mapeia o corpo Anthropic e a resposta', async () => {
    const { fetch, calls } = captureFetch(() =>
      Response.json({
        id: 'm1',
        model: 'deepseek-flash',
        content: [{ type: 'text', text: 'olá!' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 12, output_tokens: 3 },
      }),
    )
    const adapter = new DeepSeekAdapter({ apiKey: 'sk-test', fetch })
    const response = await adapter.complete(request)

    expect(calls[0]?.url).toBe(`${DEEPSEEK_BASE_URL}/v1/messages`)
    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('sk-test')
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>
    expect(body.model).toBe('deepseek-flash')
    expect(body.system).toBe('seja breve')
    expect(body.stream).toBe(false)
    expect(body.messages).toHaveLength(3)
    // tool_use e tool_result mapeados para o formato Anthropic
    const messages = body.messages as { role: string; content: { type: string; id?: string; name?: string; tool_use_id?: string }[] }[]
    expect(messages[1]).toMatchObject({ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read' }] })
    expect(messages[2]).toMatchObject({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1' }] })

    expect(response.content).toEqual([{ type: 'text', text: 'olá!' }])
    expect(response.usage).toEqual({ inputTokens: 12, outputTokens: 3 })
    expect(response.stopReason).toBe('end_turn')
  })

  it('429 vira LlmRateLimitError e 500 vira LlmServerError', async () => {
    const rateLimited = captureFetch(() => new Response('muitos pedidos', { status: 429 }))
    const adapter = new DeepSeekAdapter({ apiKey: 'sk', fetch: rateLimited.fetch })
    await expect(adapter.complete(request)).rejects.toThrow(LlmRateLimitError)

    const broken = captureFetch(() => new Response('boom', { status: 500 }))
    const adapter2 = new DeepSeekAdapter({ apiKey: 'sk', fetch: broken.fetch })
    await expect(adapter2.complete(request)).rejects.toThrow(LlmServerError)
  })
})

describe('DeepSeekAdapter.stream', () => {
  it('traduz o SSE para eventos e monta a resposta', async () => {
    const { fetch, calls } = captureFetch(() =>
      sseBody([
        'event: message_start\n',
        'data: {"type":"message_start","message":{"id":"m9","model":"deepseek-flash"}}\n\n',
        'event: content_block_delta\n',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ola "}}\n\n',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"mundo"}}\n\n',
        'event: message_delta\n',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]),
    )
    const adapter = new DeepSeekAdapter({ apiKey: 'sk', fetch })
    const events: LlmStreamEvent[] = []
    for await (const event of adapter.stream(request)) events.push(event)

    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>
    expect(body.stream).toBe(true)
    expect(events[0]).toEqual({ type: 'message_start', id: 'm9', model: 'deepseek-flash' })
    expect(events.filter((e) => e.type === 'text_delta')).toHaveLength(2)
    expect(events.at(-1)).toEqual({ type: 'message_stop' })

    const response = await collectStream(
      { async *[Symbol.asyncIterator]() { for (const e of events) yield e } },
      request,
    )
    expect(response.content).toEqual([{ type: 'text', text: 'ola mundo' }])
    expect(response.stopReason).toBe('end_turn')
    expect(response.usage.outputTokens).toBe(7)
  })

  it('acumula tool_use via input_json_delta', async () => {
    const { fetch } = captureFetch(() =>
      sseBody([
        'data: {"type":"content_block_start","content_block":{"type":"tool_use","id":"t7","name":"write"}}\n\n',
        'data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}\n\n',
        'data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"\\"b.txt\\"}"}}\n\n',
        'data: {"type":"content_block_stop"}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ]),
    )
    const adapter = new DeepSeekAdapter({ apiKey: 'sk', fetch })
    const response = await collectStream(adapter.stream(request), request)
    expect(response.content).toEqual([{ type: 'tool_use', id: 't7', name: 'write', input: { path: 'b.txt' } }])
  })
})
