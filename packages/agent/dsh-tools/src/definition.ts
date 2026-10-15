import type { JsonSchema } from '@open-harness/dsh-llm'

// ---------------------------------------------------------------------------
// Definição de uma tool
// ---------------------------------------------------------------------------

/**
 * Contexto entregue a cada execução. `cwd` é o directorio de trabalho do
 * agente (as tools de fs resolvem caminhos relativos contra ele). `signal`
 * propaga o cancelamento do loop.
 */
export interface ToolContext {
  cwd: string
  signal?: AbortSignal
}

/**
 * Resultado de uma tool. `content` é o que vai para o modelo — string, ou
 * blocos (texto/imagem). `isError` sinaliza falha sem abortar o loop (o
 * modelo recebe o erro e corrige-se na iteração seguinte).
 */
export type ToolOutput =
  | string
  | Array<{ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }>

export interface ToolResult {
  content: ToolOutput
  isError?: boolean
}

/** Definição completa de uma tool registada no registry. */
export interface ToolDefinition {
  name: string
  description: string
  inputSchema: JsonSchema
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>
}

// ---------------------------------------------------------------------------
// Erros
// ---------------------------------------------------------------------------

export class ToolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolError'
  }
}

/** Nome duplicado ao registar. */
export class ToolExistsError extends ToolError {
  constructor(name: string) {
    super(`tool already registered: ${name}`)
    this.name = 'ToolExistsError'
  }
}

/** Tool pedida pelo modelo mas não registada. */
export class UnknownToolError extends ToolError {
  constructor(name: string) {
    super(`unknown tool: ${name}`)
    this.name = 'UnknownToolError'
  }
}

/** Input não é um objecto (o wire Anthropic exige objeto para tool_use). */
export class InvalidToolInputError extends ToolError {
  constructor(name: string, detail: string) {
    super(`invalid input for tool ${name}: ${detail}`)
    this.name = 'InvalidToolInputError'
  }
}

/** Tool bloqueada por `restrict` (whitelist). */
export class ToolNotAllowedError extends ToolError {
  constructor(name: string) {
    super(`tool not allowed by policy: ${name}`)
    this.name = 'ToolNotAllowedError'
  }
}
