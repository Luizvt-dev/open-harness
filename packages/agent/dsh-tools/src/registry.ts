import type { LlmToolSpec } from '@open-harness/dsh-llm'
import {
  InvalidToolInputError,
  ToolError,
  ToolExistsError,
  ToolNotAllowedError,
  UnknownToolError,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
} from './definition.js'

/** Resultado de uma execução: sucesso ou falha tipada, nunca throw implícito. */
export type ExecOutcome =
  | { ok: true; result: ToolResult }
  | { ok: false; error: ToolError }

export interface ToolRegistryOptions {
  /** Whitelist de nomes permitidos. `undefined` = tudo permitido. */
  allow?: ReadonlySet<string>
}

/**
 * Registo de tools do agente. Guarda definições, expõe os specs para o wire
 * (`toLlmTools`) e executa com validação de input. `restrict()` devolve um
 * registry novo com whitelist — imutável, para compor policies sem mutar o
 * original.
 */
export class ToolRegistry {
  private readonly defs = new Map<string, ToolDefinition>()
  private readonly allow?: ReadonlySet<string>

  constructor(options: ToolRegistryOptions = {}) {
    this.allow = options.allow
  }

  /** Regista uma tool; lança `ToolExistsError` em nome duplicado. */
  register(def: ToolDefinition): this {
    if (this.defs.has(def.name)) throw new ToolExistsError(def.name)
    this.defs.set(def.name, def)
    return this
  }

  /** Regista várias tools (ordem preservada). */
  registerAll(defs: readonly ToolDefinition[]): this {
    for (const def of defs) this.register(def)
    return this
  }

  has(name: string): boolean {
    return this.defs.has(name)
  }

  get(name: string): ToolDefinition | undefined {
    return this.defs.get(name)
  }

  /** Nomes registados, em ordem de registo. */
  names(): string[] {
    return [...this.defs.keys()]
  }

  /**
   * Novo registry contendo só as tools cujos nomes estão em `allow`.
   * A whitelist compõe-se com a herdada (intersecção).
   */
  restrict(allow: readonly string[]): ToolRegistry {
    const next = new Set(allow.filter((name) => this.defs.has(name)))
    if (this.allow) {
      for (const name of [...next]) if (!this.allow.has(name)) next.delete(name)
    }
    const registry = new ToolRegistry({ allow: next })
    for (const name of next) {
      const def = this.defs.get(name)
      if (def) registry.defs.set(name, def)
    }
    return registry
  }

  /** Specs no formato do wire Anthropic (`input_schema`). */
  toLlmTools(): LlmToolSpec[] {
    return [...this.defs.values()]
      .filter((def) => this.allowed(def.name))
      .map((def) => ({
        name: def.name,
        description: def.description,
        input_schema: def.inputSchema,
      }))
  }

  private allowed(name: string): boolean {
    return this.allow === undefined || this.allow.has(name)
  }

  /**
   * Executa uma tool. Valida nome e input, e captura erros de execução como
   * `isError` (o loop nunca propaga throw de tool para cima do LLM).
   */
  async execute(name: string, input: unknown, ctx: ToolContext): Promise<ExecOutcome> {
    if (!this.allowed(name)) return { ok: false, error: new ToolNotAllowedError(name) }
    const def = this.defs.get(name)
    if (!def) return { ok: false, error: new UnknownToolError(name) }
    if (input !== undefined && (typeof input !== 'object' || input === null || Array.isArray(input))) {
      return { ok: false, error: new InvalidToolInputError(name, 'expected an object') }
    }
    const record = (input ?? {}) as Record<string, unknown>
    try {
      const result = await def.execute(record, ctx)
      return { ok: true, result }
    } catch (error) {
      const toolError =
        error instanceof ToolError ? error : new ToolError(`tool ${name} failed: ${(error as Error).message}`)
      return { ok: false, error: toolError }
    }
  }
}
