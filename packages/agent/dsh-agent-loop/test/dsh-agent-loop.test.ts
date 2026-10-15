import { describe, expect, it } from 'vitest'
import {
  AgentLoop,
  responseText,
  sessionToMessages,
  type LoopClock,
  type LoopEvent,
  type SessionPersister,
} from '@open-harness/dsh-agent-loop'
import {
  LlmClient,
  type LlmAdapter,
  type LlmRequest,
  type LlmResponse,
  type LlmStreamEvent,
} from '@open-harness/dsh-llm'
import { Session } from '@open-harness/dsh-session'
import type { SessionFile } from '@open-harness/dsh-session-format'
import { ToolRegistry, type ToolDefinition } from '@open-harness/dsh-tools'

// ---------------------------------------------------------------------------
// Fakes determinísticos
// ---------------------------------------------------------------------------

/** Adapter scriptável: devolve as respostas pela ordem e grava os pedidos. */
class ScriptedAdapter implements LlmAdapter {
  readonly id = 'scripted'
  readonly requests: LlmRequest[] = []
  private readonly responses: LlmResponse[]

  constructor(responses: LlmResponse[]) {
    this.responses = responses
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request)
    const next = this.responses.shift()
    if (!next) throw new Error('scripted adapter: no more responses')
    return next
  }

  /**
   * Mesmas respostas, mas em forma de stream.
   *
   * É o caminho que o loop usa quando tem observador — por isso tem de
   * produzir os mesmos blocos, emitindo-os como `text_delta`/`tool_use_start`.
   */
  async *stream(request: LlmRequest): AsyncGenerator<LlmStreamEvent> {
    const next = this.responses[0]
    if (!next) throw new Error('scripted adapter: no more responses')
    this.requests.push(request)
    yield { type: 'message_start', id: 'msg_scripted', model: next.model }
    for (const block of next.content) {
      if (block.type === 'text') {
        yield { type: 'text_delta', text: block.text }
      } else if (block.type === 'tool_use') {
        yield { type: 'tool_use_start', id: block.id, name: block.name }
        yield { type: 'tool_use_delta', partialJson: JSON.stringify(block.input) }
        yield { type: 'tool_use_stop', id: block.id }
      }
    }
    yield { type: 'message_delta', stopReason: next.stopReason, usage: next.usage }
    yield { type: 'message_stop' }
    // A resposta já foi consumida — o próximo pedido busca a seguinte.
    this.responses.shift()
  }
}

function textResponse(text: string): LlmResponse {
  return {
    model: 'deepseek-flash',
    content: [{ type: 'text', text }],
    stopReason: 'end_turn',
    usage: { inputTokens: 10, outputTokens: 5 },
  }
}

function toolUseResponse(name: string, input: unknown, id = 'toolu_1'): LlmResponse {
  return {
    model: 'deepseek-flash',
    content: [{ type: 'tool_use', id, name, input }],
    stopReason: 'tool_use',
    usage: { inputTokens: 12, outputTokens: 8 },
  }
}

/** Clock manual para registos determinísticos. */
function manualClock(start = 1_000): LoopClock {
  let t = start
  return { now: () => t++ }
}

/** Persister que guarda os snapshots em memória. */
class MemoryPersister implements SessionPersister {
  readonly snapshots: SessionFile[] = []
  async save(file: SessionFile): Promise<void> {
    this.snapshots.push(file)
  }
}

function echoTool(calls: string[]): ToolDefinition {
  return {
    name: 'echo',
    description: 'Echo back',
    inputSchema: { type: 'object' },
    async execute(input) {
      calls.push(String(input.text ?? ''))
      return { content: `echo:${String(input.text ?? '')}` }
    },
  }
}

function loopOf(
  responses: LlmResponse[],
  options: {
    registry?: ToolRegistry
    limits?: { maxStepsPerTurn: number }
    onEvent?: (event: LoopEvent) => void
    policy?: { authorize?: (call: { name: string }) => boolean | Promise<boolean> }
  } = {},
): {
  loop: AgentLoop
  adapter: ScriptedAdapter
  session: Session
  persister: MemoryPersister
} {
  const adapter = new ScriptedAdapter(responses)
  const client = new LlmClient({ adapter })
  const session = new Session({ id: 'session-test', cwd: '/repo' })
  const persister = new MemoryPersister()
  const registry = options.registry ?? new ToolRegistry()
  const loop = new AgentLoop(client, session, {
    registry,
    model: 'deepseek-flash',
    system: 'system prompt',
    clock: manualClock(),
    persister,
    ...(options.limits ? { limits: options.limits } : {}),
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
    ...(options.policy?.authorize ? { policy: { authorize: options.policy.authorize } } : {}),
  })
  return { loop, adapter, session, persister }
}

// ---------------------------------------------------------------------------

describe('sessionToMessages', () => {
  it('converte registos em mensagens alternadas', () => {
    const session = new Session({ id: 's', cwd: '/repo' })
    session.addUser('olá')
    session.addAssistant('oi')
    const messages = sessionToMessages(session.records)
    expect(messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'olá' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'oi' }] },
    ])
  })

  it('funde tool_use e tool_result nas mensagens certas', () => {
    const session = new Session({ id: 's', cwd: '/repo' })
    session.addUser('faz algo')
    session.addToolUse('echo', { text: 'x' }, 'toolu_1')
    session.addToolResult('toolu_1', 'echo:x')
    const messages = sessionToMessages(session.records)
    expect(messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'faz algo' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'echo', input: { text: 'x' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'echo:x' }],
      },
    ])
  })

  it('ignora summary e checkpoint', () => {
    const session = new Session({ id: 's', cwd: '/repo' })
    session.addUser('olá')
    session.addSummary('resumo')
    session.addCheckpoint({ at: 1 })
    const messages = sessionToMessages(session.records)
    expect(messages).toHaveLength(1)
  })
})

describe('responseText', () => {
  it('concatena blocos de texto', () => {
    const response: LlmResponse = {
      model: 'm',
      content: [
        { type: 'text', text: 'olá ' },
        { type: 'tool_use', id: 't', name: 'n', input: {} },
        { type: 'text', text: 'mundo' },
      ],
      stopReason: 'end_turn',
      usage: { inputTokens: 0, outputTokens: 0 },
    }
    expect(responseText(response)).toBe('olá mundo')
  })
})

describe('AgentLoop — turno simples', () => {
  it('responde directamente sem tools e regista user+assistant', async () => {
    const { loop, session } = loopOf([textResponse('olá!')])
    const outcome = await loop.runTurn('diz olá')

    expect(outcome.text).toBe('olá!')
    expect(outcome.steps).toBe(1)
    expect(outcome.toolExecutions).toEqual([])
    expect(outcome.stoppedByLimit).toBe(false)

    const types = session.records.map((r) => r.type)
    expect(types).toContain('message')
    expect(session.records.filter((r) => r.type === 'message')).toHaveLength(2)
  })

  it('envia system prompt e tools no pedido', async () => {
    const calls: string[] = []
    const registry = new ToolRegistry().register(echoTool(calls))
    const { loop, adapter } = loopOf([textResponse('ok')], { registry })
    await loop.runTurn('oi')

    const request = adapter.requests[0]!
    expect(request.system).toBe('system prompt')
    expect(request.tools?.map((t) => t.name)).toEqual(['echo'])
    expect(request.model).toBe('deepseek-flash')
  })
})

describe('AgentLoop — checkpoint antes de cada request', () => {
  it('grava um checkpoint + snapshot antes de cada request LLM', async () => {
    const calls: string[] = []
    const registry = new ToolRegistry().register(echoTool(calls))
    const { loop, persister } = loopOf(
      [toolUseResponse('echo', { text: 'a' }), textResponse('feito')],
      { registry },
    )
    await loop.runTurn('usa a tool')

    // 2 requests → pelo menos 2 checkpoints registados
    const checkpoints = persister.snapshots.flatMap((s) => s.records.filter((r) => r.type === 'checkpoint'))
    expect(checkpoints.length).toBeGreaterThanOrEqual(2)

    // Cada snapshot guarda o ficheiro inteiro até esse momento (cabeçalho v4)
    for (const snapshot of persister.snapshots) {
      expect(snapshot.header.type).toBe('session')
      expect(snapshot.header.version).toBe(4)
      expect(snapshot.header.id).toBe('session-test')
    }
  })

  it('o snapshot antecede sempre a escrita do resultado seguinte', async () => {
    const calls: string[] = []
    const registry = new ToolRegistry().register(echoTool(calls))
    const { loop, persister } = loopOf(
      [toolUseResponse('echo', { text: 'a' }), textResponse('feito')],
      { registry },
    )
    await loop.runTurn('usa a tool')

    // O penúltimo snapshot termina antes do tool_result; o último já o inclui.
    const withToolResult = persister.snapshots.findIndex((s) =>
      s.records.some((r) => r.type === 'tool_result'),
    )
    const withoutToolResult = persister.snapshots.findIndex(
      (s) => !s.records.some((r) => r.type === 'tool_result'),
    )
    expect(withoutToolResult).toBeGreaterThanOrEqual(0)
    expect(withToolResult).toBeGreaterThan(withoutToolResult)
  })
})

describe('AgentLoop — execução de tools', () => {
  it('executa a tool pedida e continua até resposta final', async () => {
    const calls: string[] = []
    const registry = new ToolRegistry().register(echoTool(calls))
    const { loop, session } = loopOf(
      [toolUseResponse('echo', { text: 'abc' }), textResponse('result: echo:abc')],
      { registry },
    )
    const outcome = await loop.runTurn('ecoa abc')

    expect(calls).toEqual(['abc'])
    expect(outcome.steps).toBe(2)
    expect(outcome.text).toBe('result: echo:abc')
    expect(outcome.toolExecutions).toHaveLength(1)
    expect(outcome.toolExecutions[0]).toMatchObject({
      name: 'echo',
      output: 'echo:abc',
      isError: false,
    })

    // tool_result registado na sessão — `toolUseId` é o **id do bloco
    // tool_use** (não o nome da tool), que é o que volta ao wire como
    // `tool_use_id` no passo seguinte.
    const results = session.records.filter((r) => r.type === 'tool_result')
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ toolUseId: 'toolu_1', output: 'echo:abc', isError: false })

    const assistant = session.records.find((r) => r.type === 'message' && r.role === 'assistant')
    expect(assistant?.content?.find((block) => block.type === 'tool_use')?.id).toBe(results[0]!.toolUseId)
  })

  it('marca erro de tool sem abortar o loop', async () => {
    const registry = new ToolRegistry().register({
      name: 'boom',
      description: 'throws',
      inputSchema: { type: 'object' },
      async execute() {
        throw new Error('kaboom')
      },
    })
    const { loop, session } = loopOf(
      [toolUseResponse('boom', {}, 'toolu_err'), textResponse('recuperei')],
      { registry },
    )
    const outcome = await loop.runTurn('explode')

    expect(outcome.toolExecutions[0]).toMatchObject({ isError: true })
    expect(outcome.toolExecutions[0]?.output).toContain('kaboom')
    expect(outcome.text).toBe('recuperei')

    const results = session.records.filter((r) => r.type === 'tool_result')
    expect(results[0]).toMatchObject({ isError: true })
  })

  it('policy de aprovação pode rejeitar uma tool', async () => {
    const calls: string[] = []
    const registry = new ToolRegistry().register(echoTool(calls))
    const adapter = new ScriptedAdapter([toolUseResponse('echo', { text: 'x' }), textResponse('ok')])
    const client = new LlmClient({ adapter })
    const session = new Session({ id: 's', cwd: '/repo' })
    const loop = new AgentLoop(client, session, {
      registry,
      model: 'deepseek-flash',
      clock: manualClock(),
      policy: { authorize: () => false },
    })
    const outcome = await loop.runTurn('xeca')

    expect(calls).toEqual([]) // nunca executou
    expect(outcome.toolExecutions[0]).toMatchObject({ isError: true, output: 'rejected by policy' })
  })
})

describe('AgentLoop — limites defensivos', () => {
  it('para em maxStepsPerTurn e sinaliza stoppedByLimit', async () => {
    const calls: string[] = []
    const registry = new ToolRegistry().register(echoTool(calls))
    // o modelo nunca pára de pedir tools
    const infinite = Array.from({ length: 10 }, (_, i) => toolUseResponse('echo', { text: String(i) }))
    const { loop } = loopOf(infinite, { registry, limits: { maxStepsPerTurn: 3 } })
    const outcome = await loop.runTurn('loop infinito')

    expect(outcome.steps).toBe(3)
    expect(outcome.stoppedByLimit).toBe(true)
    expect(calls).toHaveLength(3) // os 3 steps correm a tool antes de o limite cortar
  })
})

describe('AgentLoop — traces', () => {
  it('regista um trace por step com usage', async () => {
    const { loop } = loopOf([toolUseResponse('echo', { text: 'a' }), textResponse('fim')])
    const outcome = await loop.runTurn('oi')

    expect(outcome.traces).toHaveLength(2)
    expect(outcome.traces[0]).toMatchObject({ step: 0, stopReason: 'tool_use', inputTokens: 12, outputTokens: 8 })
    expect(outcome.traces[1]).toMatchObject({ step: 1, stopReason: 'end_turn' })
  })
})

describe('AgentLoop — eventos do turno', () => {
  it('emite a narrativa completa de um turno simples', async () => {
    const events: LoopEvent[] = []
    const { loop } = loopOf([textResponse('ola mundo')], { onEvent: (event) => events.push(event) })
    const outcome = await loop.runTurn('diz olá')

    expect(outcome.text).toBe('ola mundo')
    expect(events.map((event) => event.type)).toEqual([
      'turn_start',
      'step_start',
      'text_delta',
      'step_end',
      'turn_end',
    ])
    expect(events).toContainEqual({ type: 'text_delta', text: 'ola mundo' })
    expect(events).toContainEqual({
      type: 'step_end',
      step: 0,
      stopReason: 'end_turn',
      inputTokens: 10,
      outputTokens: 5,
    })
    expect(events.at(-1)).toEqual({ type: 'turn_end', text: 'ola mundo', steps: 1, stoppedByLimit: false })
  })

  it('emite tools a começar e a terminar, com o resultado', async () => {
    const calls: string[] = []
    const registry = new ToolRegistry().register(echoTool(calls))
    const events: LoopEvent[] = []
    const { loop } = loopOf(
      [toolUseResponse('echo', { text: 'abc' }), textResponse('result: echo:abc')],
      { registry, onEvent: (event) => events.push(event) },
    )
    const outcome = await loop.runTurn('ecoa abc')

    expect(calls).toEqual(['abc'])
    expect(events.map((event) => event.type)).toEqual([
      'turn_start',
      'step_start',
      'tool_use_start',
      'tool_end',
      'step_end',
      'step_start',
      'text_delta',
      'step_end',
      'turn_end',
    ])
    expect(events).toContainEqual({
      type: 'tool_use_start',
      id: 'toolu_1',
      name: 'echo',
      input: { text: 'abc' },
    })
    expect(events).toContainEqual({
      type: 'tool_end',
      id: 'toolu_1',
      name: 'echo',
      ok: true,
      output: 'echo:abc',
      // O clock manual avança uma unidade entre o início e o fim da tool.
      durationMs: 1,
    })
    expect(outcome.steps).toBe(2)
  })

  it('anuncia a recusa de uma tool pela política', async () => {
    const events: LoopEvent[] = []
    const registry = new ToolRegistry().register(echoTool([]))
    const { loop } = loopOf(
      [toolUseResponse('echo', { text: 'x' }), textResponse('sem eco')],
      { registry, onEvent: (event) => events.push(event), policy: { authorize: () => false } },
    )
    await loop.runTurn('ecoa x')

    const start = events.find((event) => event.type === 'tool_use_start')
    const end = events.find((event) => event.type === 'tool_end')
    expect(start).toMatchObject({ name: 'echo', input: { text: 'x' } })
    expect(end).toMatchObject({ ok: false, output: 'rejected by policy' })
  })

  it('sem observador mantém o request bloqueante (nenhum evento)', async () => {
    const events: LoopEvent[] = []
    const { loop, adapter } = loopOf([textResponse('directo')])
    await loop.runTurn('oi')

    expect(events).toEqual([])
    expect(adapter.requests).toHaveLength(1)
  })
})
