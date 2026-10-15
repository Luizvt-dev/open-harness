import { describe, expect, it } from 'vitest'
import { collectStream, type FetchLike, type LlmRequest } from '@open-harness/dsh-llm'
import { ProviderRegistry } from '@open-harness/dsh-provider'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Captured {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

/** `fetch` falso que grava o pedido e devolve a resposta do handler. */
function recorder(handler: () => Response): { fetch: FetchLike; calls: Captured[] } {
  const calls: Captured[] = []
  const fetch: FetchLike = async (input, init) => {
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value
    }
    calls.push({ url: input, headers, body: JSON.parse(String(init?.body)) as Record<string, unknown> })
    return handler()
  }
  return { fetch, calls }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
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

/** Pedido com texto, tool use e tool result — cobre todos os mapeamentos. */
const request: LlmRequest = {
  model: 'gpt-4o',
  system: 'seja breve',
  messages: [
    { role: 'user', content: 'olá' },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't1', name: 'read', input: { path: 'a.txt' } }],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'conteúdo' }] },
  ],
  tools: [{ name: 'read', description: 'lê um ficheiro', input_schema: { type: 'object' } }],
  temperature: 0.2,
  topP: 0.9,
  stopSequences: ['FIM'],
}

// ---------------------------------------------------------------------------
// Anthropic (via registry)
// ---------------------------------------------------------------------------

describe('adapter anthropic-messages', () => {
  it('fala o wire da Anthropic com a chave e o endpoint do provedor', async () => {
    const { fetch, calls } = recorder(() =>
      json({
        id: 'm1',
        model: 'deepseek-flash',
        content: [{ type: 'text', text: 'olá' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 3, output_tokens: 2 },
      }),
    )
    const adapter = new ProviderRegistry({ env: { DEEPSEEK_API_KEY: 'sk-ds' }, fetch }).adapterFor(
      'deepseek/deepseek-flash',
    )
    const response = await adapter.complete({ ...request, model: 'deepseek-flash' })

    expect(calls[0]?.url).toBe('https://api.deepseek.com/anthropic/v1/messages')
    expect(calls[0]?.headers['x-api-key']).toBe('sk-ds')
    expect(calls[0]?.headers['anthropic-version']).toBe('2023-06-01')
    expect(calls[0]?.body).toMatchObject({ model: 'deepseek-flash', stream: false, system: 'seja breve' })
    expect(calls[0]?.body.messages).toEqual([
      { role: 'user', content: 'olá' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read', input: { path: 'a.txt' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'conteúdo' }] },
    ])
    expect(response.usage).toEqual({ inputTokens: 3, outputTokens: 2 })
    expect(response.stopReason).toBe('end_turn')
  })
})

// ---------------------------------------------------------------------------
// OpenAI Chat Completions
// ---------------------------------------------------------------------------

describe('adapter openai-chat', () => {
  it('usa max_completion_tokens, bearer e mapeia system/tool messages', async () => {
    const { fetch, calls } = recorder(() =>
      json({
        id: 'chatcmpl-1',
        model: 'gpt-4o',
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 3 } },
      }),
    )
    const adapter = new ProviderRegistry({ env: { OPENAI_API_KEY: 'sk-o' }, fetch }).adapterFor('openai/gpt-4o')
    const response = await adapter.complete(request)

    expect(calls[0]?.url).toBe('https://api.openai.com/v1/chat/completions')
    expect(calls[0]?.headers.authorization).toBe('Bearer sk-o')
    expect(calls[0]?.headers['x-api-key']).toBeUndefined()
    expect(calls[0]?.body).toMatchObject({
      model: 'gpt-4o',
      stream: false,
      max_completion_tokens: 16_384, // limite de saída do catálogo do gpt-4o
      temperature: 0.2,
      top_p: 0.9,
      stop: ['FIM'],
    })
    expect((calls[0]?.body as { stream_options?: unknown }).stream_options).toBeUndefined()
    expect(calls[0]?.body.tools).toEqual([
      { type: 'function', function: { name: 'read', description: 'lê um ficheiro', parameters: { type: 'object' } } },
    ])
    expect(calls[0]?.body.messages).toEqual([
      { role: 'system', content: 'seja breve' },
      { role: 'user', content: 'olá' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 't1', type: 'function', function: { name: 'read', arguments: '{"path":"a.txt"}' } }],
      },
      { role: 'tool', tool_call_id: 't1', content: 'conteúdo' },
    ])
    expect(response.stopReason).toBe('end_turn')
    expect(response.usage).toEqual({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 })
  })

  it('devolve tool_use quando o finish_reason é tool_calls', async () => {
    const { fetch, calls } = recorder(() =>
      json({
        id: 'chatcmpl-2',
        model: 'gpt-4o',
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: 'call_7', type: 'function', function: { name: 'write', arguments: '{"path":"x"}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      }),
    )
    const adapter = new ProviderRegistry({ env: { OPENAI_API_KEY: 'sk-o' }, fetch }).adapterFor('openai/gpt-4o')
    const response = await adapter.complete(request)

    expect(calls[0]?.body.max_completion_tokens).toBe(16_384)
    expect(response.stopReason).toBe('tool_use')
    expect(response.content).toEqual([
      { type: 'tool_use', id: 'call_7', name: 'write', input: { path: 'x' } },
    ])
  })

  it('pede o usage no stream (stream_options.include_usage)', async () => {
    const { fetch, calls } = recorder(() => sseBody(['data: [DONE]\n\n']))
    const adapter = new ProviderRegistry({ env: { OPENAI_API_KEY: 'sk-o' }, fetch }).adapterFor('openai/gpt-4o')
    await collectStream(adapter.stream(request), request)
    expect(calls[0]?.body.stream).toBe(true)
    expect(calls[0]?.body.stream_options).toEqual({ include_usage: true })
  })

  it('traduz o stream SSE, incluindo tool calls em várias mensagens', async () => {
    const { fetch } = recorder(() =>
      sseBody([
        'data: {"id":"chatcmpl-9","model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","content":"Olá "}}]}\n\n',
        'data: {"id":"chatcmpl-9","model":"gpt-4o","choices":[{"index":0,"delta":{"content":"mundo"}}]}\n\n',
        'data: {"id":"chatcmpl-9","model":"gpt-4o","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":""}}]}}]}\n\n',
        'data: {"id":"chatcmpl-9","model":"gpt-4o","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"pa"}}]}}]}\n\n',
        'data: {"id":"chatcmpl-9","model":"gpt-4o","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"a.txt\\"}"}}]}}]}\n\n',
        'data: {"id":"chatcmpl-9","model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        'data: {"id":"chatcmpl-9","model":"gpt-4o","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n',
        'data: [DONE]\n\n',
      ]),
    )
    const adapter = new ProviderRegistry({ env: { OPENAI_API_KEY: 'sk-o' }, fetch }).adapterFor('openai/gpt-4o')
    const response = await collectStream(adapter.stream(request), request)

    expect(response.id).toBe('chatcmpl-9')
    expect(response.content).toEqual([
      { type: 'text', text: 'Olá mundo' },
      { type: 'tool_use', id: 'call_1', name: 'read', input: { path: 'a.txt' } },
    ])
    expect(response.stopReason).toBe('tool_use')
    expect(response.usage).toEqual({ inputTokens: 10, outputTokens: 5 })
  })
})

describe('adapter openai-compatible', () => {
  it('usa max_tokens para servidores compatíveis (OpenRouter, Ollama, vLLM)', async () => {
    const { fetch, calls } = recorder(() =>
      json({ id: 'c1', model: 'x', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
    )
    const registry = new ProviderRegistry({
      env: { OPENROUTER_API_KEY: 'sk-or' },
      fetch,
      providers: { openrouter: { models: { 'openai/gpt-4o': { maxTokens: 4_096 } } } },
    })
    const adapter = registry.adapterFor('openrouter/openai/gpt-4o')
    await adapter.complete({ ...request, model: 'openai/gpt-4o' })

    expect(calls[0]?.url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(calls[0]?.body.max_tokens).toBe(4_096)
    expect(calls[0]?.body).not.toHaveProperty('max_completion_tokens')
  })

  it('funciona sem chave quando o provedor é local', async () => {
    const { fetch, calls } = recorder(() =>
      json({ id: 'c1', model: 'llama3.1:8b', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
    )
    const adapter = new ProviderRegistry({ env: {}, fetch }).adapterFor('ollama/llama3.1:8b')
    await adapter.complete(request)
    expect(calls[0]?.url).toBe('http://localhost:11434/v1/chat/completions')
    expect(calls[0]?.headers.authorization).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Google Gemini
// ---------------------------------------------------------------------------

describe('adapter google-generate', () => {
  it('usa x-goog-api-key, systemInstruction e functionDeclarations', async () => {
    const { fetch, calls } = recorder(() =>
      json({
        modelVersion: 'gemini-2.5-flash',
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ text: 'vou ler' }, { functionCall: { name: 'read', args: { path: 'a.txt' } } }],
            },
            finishReason: 'STOP',
            index: 0,
          },
        ],
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 7, cachedContentTokenCount: 4 },
      }),
    )
    const adapter = new ProviderRegistry({ env: { GEMINI_API_KEY: 'sk-g' }, fetch }).adapterFor(
      'google/gemini-2.5-flash',
    )
    const response = await adapter.complete({ ...request, model: 'gemini-2.5-flash' })

    expect(calls[0]?.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent')
    expect(calls[0]?.headers['x-goog-api-key']).toBe('sk-g')
    expect(calls[0]?.body.systemInstruction).toEqual({ parts: [{ text: 'seja breve' }] })
    expect(calls[0]?.body.generationConfig).toMatchObject({ maxOutputTokens: 65_536, temperature: 0.2, topP: 0.9 })
    // role assistant → model; tool_result → functionResponse com o nome da tool
    expect(calls[0]?.body.contents).toEqual([
      { role: 'user', parts: [{ text: 'olá' }] },
      { role: 'model', parts: [{ functionCall: { name: 'read', args: { path: 'a.txt' } } }] },
      {
        role: 'user',
        parts: [{ functionResponse: { name: 'read', response: { output: 'conteúdo' } } }],
      },
    ])
    expect(calls[0]?.body.tools).toEqual([
      {
        functionDeclarations: [
          { name: 'read', description: 'lê um ficheiro', parametersJsonSchema: { type: 'object' } },
        ],
      },
    ])

    // Gemini não devolve id nas chamadas — o adapter sintetiza um.
    expect(response.content).toEqual([
      { type: 'text', text: 'vou ler' },
      { type: 'tool_use', id: 'call_1', name: 'read', input: { path: 'a.txt' } },
    ])
    expect(response.stopReason).toBe('tool_use')
    expect(response.usage).toEqual({ inputTokens: 12, outputTokens: 7, cacheReadTokens: 4 })
  })

  it('trata STOP como end_turn e JSON inválido em tool_result como texto', async () => {
    const { fetch, calls } = recorder(() =>
      json({
        modelVersion: 'gemini-2.5-flash',
        candidates: [{ content: { role: 'model', parts: [{ text: 'pronto' }] }, finishReason: 'STOP' }],
      }),
    )
    const adapter = new ProviderRegistry({ env: { GEMINI_API_KEY: 'sk-g' }, fetch }).adapterFor(
      'google/gemini-2.5-flash',
    )
    const response = await adapter.complete({
      model: 'gemini-2.5-flash',
      messages: [
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'não é json', is_error: true }],
        },
      ],
    })

    expect((calls[0]?.body.contents as unknown[])[0]).toEqual({
      role: 'user',
      parts: [{ functionResponse: { name: 't1', response: { error: { output: 'não é json' } } } }],
    })
    expect(response.stopReason).toBe('end_turn')
    expect(response.usage).toEqual({ inputTokens: 0, outputTokens: 0 })
  })

  it('traduz o stream alt=sse e usa o usage do último chunk', async () => {
    const { fetch } = recorder(() =>
      sseBody([
        'data: {"modelVersion":"gemini-2.5-flash","candidates":[{"content":{"role":"model","parts":[{"text":"Oi"}]},"index":0}]}\n\n',
        'data: {"modelVersion":"gemini-2.5-flash","candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"write","args":{"path":"x","content":"y"}}}]},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":9}}\n\n',
      ]),
    )
    const adapter = new ProviderRegistry({ env: { GEMINI_API_KEY: 'sk-g' }, fetch }).adapterFor(
      'google/gemini-2.5-flash',
    )
    const streamed: LlmRequest = {
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'olá' }],
    }
    const response = await collectStream(adapter.stream(streamed), streamed)

    expect(response.id).toBe('gemini-2.5-flash')
    expect(response.content).toEqual([
      { type: 'text', text: 'Oi' },
      { type: 'tool_use', id: 'call_1', name: 'write', input: { path: 'x', content: 'y' } },
    ])
    expect(response.stopReason).toBe('tool_use')
    expect(response.usage).toEqual({ inputTokens: 5, outputTokens: 9 })
  })

  it('reporta erros HTTP com o status', async () => {
    const { fetch } = recorder(() => new Response('quota excedida', { status: 429 }))
    const adapter = new ProviderRegistry({ env: { GEMINI_API_KEY: 'sk-g' }, fetch }).adapterFor(
      'google/gemini-2.5-flash',
    )
    await expect(adapter.complete({ model: 'gemini-2.5-flash', messages: [] })).rejects.toThrow(/429/)
  })
})
