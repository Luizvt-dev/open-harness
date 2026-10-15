import type { LlmToolSpec } from '@open-harness/dsh-llm'
import type { ToolRegistry } from '@open-harness/dsh-tools'

/** Opções de execução de uma tool dentro do loop. */
export interface ToolExecOptions {
  /**
   * Id do bloco `tool_use` que pediu a chamada. Fica gravado no registo
   * `tool_result.toolUseId` e volta ao wire como `tool_use_id` — sem ele o
   * provedor rejeitaria turnos com mais de um step de tools.
   */
  id: string
  /** Nome da tool. */
  name: string
  /** Input em objecto (validado contra o schema antes de executar). */
  input: Record<string, unknown>
}

/** Resultado de executar uma tool, pronto a serializar no registo. */
export interface ToolExecResult {
  name: string
  input: Record<string, unknown>
  output: string
  isError: boolean
  durationMs: number
}

/** Registo imutável de uma chamada LLM feita pelo loop. */
export interface TurnTrace {
  /** Índice do step dentro do turno. */
  step: number
  model: string
  /** Nº de mensagens enviadas no pedido. */
  messageCount: number
  /** Specs de tools enviadas. */
  toolSpecs: LlmToolSpec[]
  stopReason: string
  inputTokens: number
  outputTokens: number
}

/** O que cada step decidiu fazer. */
export type StepDecision =
  | { kind: 'call-tools'; calls: ToolExecOptions[] }
  | { kind: 'final' }
  | { kind: 'stopped' }

/** Política de limites do loop (defensiva: evita loop infinito). */
export interface LoopLimits {
  /** Máximo de steps dentro de um turno. Default 32. */
  maxStepsPerTurn: number
  /** Teto de tools por step. Default 8. */
  maxToolCallsPerStep: number
}

export const DEFAULT_LOOP_LIMITS: LoopLimits = {
  maxStepsPerTurn: 32,
  maxToolCallsPerStep: 8,
}

/** Resultado completo de um turno. */
export interface TurnOutcome {
  /** Texto final do assistente (vazio se só houve tools). */
  text: string
  steps: number
  toolExecutions: ToolExecResult[]
  traces: TurnTrace[]
  /** O turno terminou por limite (não por decisão natural do modelo)? */
  stoppedByLimit: boolean
}

/** Política de execução de tools do loop. */
export interface ToolExecutionPolicy {
  /** Decidir se uma tool pode correr (ex.: aprovação). Default: sempre. */
  authorize?(call: ToolExecOptions): boolean | Promise<boolean>
}

/** Opções do loop. */
export interface AgentLoopOptions {
  registry: ToolRegistry
  system?: string
  model: string
  limits?: Partial<LoopLimits>
  policy?: ToolExecutionPolicy
  /** Timeout por request LLM (ms). */
  requestTimeoutMs?: number
}
