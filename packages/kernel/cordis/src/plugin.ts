import { InvalidPluginError } from './errors.js'
import type { InjectSpec, Plugin, PluginFunction, PluginObject } from './types.js'
import type { Context } from './context.js'

export interface NormalizedPlugin {
  name?: string
  required: string[]
  optional: string[]
  apply(ctx: Context, config: any): unknown
}

export function splitInject(inject?: InjectSpec): { required: string[]; optional: string[] } {
  if (!inject) return { required: [], optional: [] }
  if (Array.isArray(inject)) return { required: [...inject], optional: [] }
  return { required: [...(inject.required ?? [])], optional: [...(inject.optional ?? [])] }
}

/**
 * Normaliza a definição aceita pelo kernel: função `(ctx, config)` ou objeto
 * com `apply`. Classes e exports de módulo são tratados pelo
 * `cordis-plugin-loader` antes de chegar aqui.
 */
export function normalizePlugin<C>(def: Plugin<C>): NormalizedPlugin {
  if (typeof def === 'function') {
    const fn = def as PluginFunction<C>
    return { name: fn.name || undefined, ...splitInject(fn.inject), apply: fn }
  }
  if (def && typeof def === 'object') {
    const obj = def as PluginObject<C>
    if (typeof obj.apply === 'function') {
      return {
        name: obj.name,
        ...splitInject(obj.inject),
        apply: (ctx, config) => obj.apply(ctx, config as C),
      }
    }
  }
  throw new InvalidPluginError('plugin definition must be a function or an object with an `apply` method')
}
