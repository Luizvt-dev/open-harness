import type { Context } from './context.js'

export type { Disposer } from '@open-harness/cosmokit'

export type EventName = string | symbol
export type Listener = (...args: any[]) => void
export type WaterfallListener<T> = (value: T, ...args: any[]) => T

/**
 * Declaração de dependências de um plugin.
 * - array → serviços obrigatórios
 * - objeto → obrigatórios + opcionais (os opcionais não bloqueiam ativação)
 */
export type InjectSpec = string[] | { required?: string[]; optional?: string[] }

/** Plugin como objeto: `{ apply }` com estado próprio (suporta `reconfigure` no loader). */
export interface PluginObject<C = any> {
  name?: string
  inject?: InjectSpec
  /**
   * `unknown` de propósito: `apply: (ctx) => ctx.set('x', 1)` é idiomático e
   * não pode falhar o typecheck por devolver `Context`. Promises são aguardadas.
   */
  apply(ctx: Context, config: C): unknown
  /** Atualiza config sem reiniciar a fibra (usado pelo loader no HMR). Opcional. */
  reconfigure?(config: C): unknown
}

/** Plugin como função: `(ctx, config) => void`. Metadados em propriedades estáticas. */
export interface PluginFunction<C = any> {
  (ctx: Context, config: C): unknown
  name?: string
  inject?: InjectSpec
}

export type Plugin<C = any> = PluginObject<C> | PluginFunction<C>

/** Evento emitido na raiz quando um serviço fica disponível ou desaparece. */
export interface ServiceEvent {
  name: string
  type: 'available' | 'lost'
  value?: unknown
}

export type ContextStatus = 'idle' | 'active' | 'failed' | 'disposed'
