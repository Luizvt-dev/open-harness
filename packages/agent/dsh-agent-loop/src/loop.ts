import type { LlmClient, LlmResponse, LlmToolSpec } from '@open-harness/dsh-llm'
import type { Session } from '@open-harness/dsh-session'
import type { SessionFile } from '@open-harness/dsh-session-format'
import { ToolRegistry, type ToolContext } from '@open-harness/dsh-tools'
import { responseText, sessionToMessages } from './messages.js'
import {
  DEFAULT_LOOP_LIMITS,
  type AgentLoopOptions,
  type LoopEvent,
  type LoopLimits,
  type ToolExecOptions,
  type ToolExecResult,
  type ToolExecutionPolicy,
  type TurnOutcome,
  type TurnTrace,
} from './types.js'

/** Injecção mínima de persistência — o loop só precisa de guardar snapshots. */
export interface SessionPersister {
  save(file: SessionFile): Promise<void>
}

/** Injecção de clock (testes determinísticos). */
export interface LoopClock {
  now(): number
}

const systemClock: LoopClock = { now: () => Date.now() }

/**
 * O loop de agente: converte a sessão em mensagens, faz **checkpoint antes de
 * cada request**, chama o LLM, executa as tools pedidas e persiste a sessão.
 *
 * Um *turno* (`runTurn`) é uma mensagem do utilizador → N steps de
 * tool-calling → resposta final. Cada step é um request LLM autónomo.
 */
export class AgentLoop {
  private readonly client: LlmClient
  private readonly session: Session
  private readonly registry: ToolRegistry
  private readonly policy?: ToolExecutionPolicy
  private readonly model: string
  private readonly system?: string
  private readonly limits: LoopLimits
  private readonly persister?: SessionPersister
  private readonly clock: LoopClock
  private readonly requestTimeoutMs?: number
  private readonly onEvent?: (event: LoopEvent) => void

  constructor(
    client: LlmClient,
    session: Session,
    options: AgentLoopOptions & { persister?: SessionPersister; clock?: LoopClock },
  ) {
    this.client = client
    this.session = session
    this.registry = options.registry
    this.policy = options.policy
    this.model = options.model
    this.system = options.system
    this.limits = { ...DEFAULT_LOOP_LIMITS, ...options.limits }
    this.persister = options.persister
    this.clock = options.clock ?? systemClock
    this.requestTimeoutMs = options.requestTimeoutMs
    this.onEvent = options.onEvent
  }

  /** Com observador ligado, o loop fala o protocolo de stream do provedor. */
  private get streaming(): boolean {
    return (this.turnObserver ?? this.onEvent) !== undefined
  }

  private emit(event: LoopEvent): void {
    ;(this.turnObserver ?? this.onEvent)?.(event)
  }

  /**
   * Observador do turno em curso.
   *
   * O loop dá suporte a observador fixo (construção) e a um por turno — a
   * superfície web precisa do segundo: cada sessão é um agente próprio e cada
   * visualizador pode querer a sua subscrição. Os turnos de uma sessão são
   * sequenciais, por isso há no máximo um activo de cada vez.
   */
  private turnObserver?: (event: LoopEvent) => void

  /** Tools expostas ao modelo (snapshot actual do registry). */
  get toolSpecs(): LlmToolSpec[] {
    return this.registry.toLlmTools()
  }

  /** Regista a mensagem do utilizador e corre um turno completo. */
  async runTurn(
    userText: string,
    signal?: AbortSignal,
    onEvent?: (event: LoopEvent) => void,
  ): Promise<TurnOutcome> {
    this.session.addUser(userText, this.clock.now())
    return await this.nextTurn(signal, onEvent)
  }

  /**
   * Continua a sessão até à próxima resposta final do assistente. Cada iteração
   * é um *step*: checkpoint → request LLM → (se pedir tools) executa e persiste,
   * senão devolve a resposta.
   */
  async nextTurn(signal?: AbortSignal, onEvent?: (event: LoopEvent) => void): Promise<TurnOutcome> {
    this.turnObserver = onEvent
    try {
      return await this.runSteps(signal)
    } finally {
      this.turnObserver = undefined
    }
  }

  private async runSteps(signal?: AbortSignal): Promise<TurnOutcome> {
    const toolExecutions: ToolExecResult[] = []
    const traces: TurnTrace[] = []
    let text = ''
    let stoppedByLimit = false
    this.emit({ type: 'turn_start' })

    for (let step = 0; step < this.limits.maxStepsPerTurn; step++) {
      this.emit({ type: 'step_start', step })
      // CHECKPOINT antes de cada request (critério da Fase 2).
      await this.checkpoint()

      const response = await this.request(signal)
      traces.push(this.traceOf(step, response))

      // Persistir a resposta do assistente (mensagem + eventuais tool_use).
      this.recordAssistant(response)

      const calls = this.toolCallsOf(response)
      if (calls.length === 0) {
        text = responseText(response)
        this.emitStepEnd(step, response)
        await this.persist()
        return this.finish({ text, steps: step + 1, toolExecutions, traces, stoppedByLimit })
      }

      const accepted = calls.slice(0, this.limits.maxToolCallsPerStep)
      const results = await this.runTools(accepted, signal)
      toolExecutions.push(...results)
      // O step só termina depois das tools — é a ordem que a UI espera ver.
      this.emitStepEnd(step, response)

      if (step === this.limits.maxStepsPerTurn - 1) stoppedByLimit = true
    }

    await this.persist()
    return this.finish({
      text,
      steps: this.limits.maxStepsPerTurn,
      toolExecutions,
      traces,
      stoppedByLimit,
    })
  }

  private emitStepEnd(step: number, response: LlmResponse): void {
    this.emit({
      type: 'step_end',
      step,
      stopReason: response.stopReason,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
    })
  }

  /** Anuncia o fim do turno e devolve o resultado. */
  private finish(outcome: TurnOutcome): TurnOutcome {
    this.emit({
      type: 'turn_end',
      text: outcome.text,
      steps: outcome.steps,
      stoppedByLimit: outcome.stoppedByLimit,
    })
    return outcome
  }

  private async request(signal?: AbortSignal): Promise<LlmResponse> {
    const request = {
      model: this.model,
      messages: sessionToMessages(this.session.records),
      tools: this.registry.toLlmTools(),
      ...(this.system ? { system: this.system } : {}),
    }
    const options = {
      ...(signal ? { signal } : {}),
      ...(this.requestTimeoutMs ? { timeoutMs: this.requestTimeoutMs } : {}),
    }
    // Sem observador, o request bloqueante continua a ser o caminho rápido.
    if (!this.streaming) return await this.client.complete(request, options)
    // Com observador, usamos o stream para o texto poder ser emitido à medida
    // que chega. A resposta final monta-se exactamente igual.
    return await this.client.completeFromStream(request, options, (event) => {
      if (event.type === 'text_delta' && event.text) this.emit({ type: 'text_delta', text: event.text })
    })
  }

  private toolCallsOf(response: LlmResponse): ToolExecOptions[] {
    return response.content
      .filter((block) => block.type === 'tool_use')
      .map((block) => {
        const input = block.input
        return {
          id: block.id,
          name: block.name,
          input:
            input && typeof input === 'object' && !Array.isArray(input)
              ? (input as Record<string, unknown>)
              : {},
        }
      })
  }

  private recordAssistant(response: LlmResponse): void {
    const timestamp = this.clock.now()
    const blocks = response.content.map((block) => {
      switch (block.type) {
        case 'text':
          return { type: 'text', text: block.text }
        case 'tool_use':
          return { type: 'tool_use', id: block.id, name: block.name, input: block.input }
        case 'tool_result':
          return {
            type: 'tool_result',
            tool_use_id: block.tool_use_id,
            content: block.content,
            is_error: block.is_error,
          }
        default:
          return { type: 'text', text: '' }
      }
    })
    this.session.addMessage('assistant', blocks, timestamp)
  }

  private async runTools(calls: ToolExecOptions[], signal?: AbortSignal): Promise<ToolExecResult[]> {
    const results: ToolExecResult[] = []
    const ctx: ToolContext = { cwd: this.session.header.cwd, ...(signal ? { signal } : {}) }
    for (const call of calls) {
      // Antes de decidir: a UI já pode mostrar a chamada e pedir aprovação.
      this.emit({ type: 'tool_use_start', id: call.id, name: call.name, input: call.input })

      if (this.policy?.authorize) {
        const allowed = await this.policy.authorize(call)
        if (!allowed) {
          this.session.addToolResult(call.id, 'rejected by policy', true, this.clock.now())
          results.push({ ...emptyResult(call), output: 'rejected by policy', isError: true, durationMs: 0 })
          this.emit({
            type: 'tool_end',
            id: call.id,
            name: call.name,
            ok: false,
            output: 'rejected by policy',
            durationMs: 0,
          })
          continue
        }
      }
      const started = this.clock.now()
      const outcome = await this.registry.execute(call.name, call.input, ctx)
      const durationMs = Math.max(0, this.clock.now() - started)
      const result: ToolExecResult = outcome.ok
        ? {
            ...emptyResult(call),
            output: typeof outcome.result.content === 'string' ? outcome.result.content : JSON.stringify(outcome.result.content),
            isError: Boolean(outcome.result.isError),
            durationMs,
          }
        : { ...emptyResult(call), output: outcome.error.message, isError: true, durationMs }
      this.session.addToolResult(call.id, result.output, result.isError, this.clock.now())
      results.push(result)
      this.emit({
        type: 'tool_end',
        id: call.id,
        name: call.name,
        ok: !result.isError,
        output: result.output,
        durationMs,
      })
    }
    return results
  }

  /** Checkpoint + persistência antes de cada request LLM. */
  private async checkpoint(): Promise<void> {
    this.session.addCheckpoint({ at: this.clock.now(), records: this.session.length }, this.clock.now())
    await this.persist()
  }

  private async persist(): Promise<void> {
    if (this.persister) await this.persister.save(this.session.toFile())
  }

  private traceOf(step: number, response: LlmResponse): TurnTrace {
    return {
      step,
      model: response.model,
      messageCount: sessionToMessages(this.session.records).length,
      toolSpecs: this.registry.toLlmTools(),
      stopReason: response.stopReason,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
    }
  }
}

function emptyResult(call: ToolExecOptions): { name: string; input: Record<string, unknown> } {
  return { name: call.name, input: call.input }
}
