/**
 * Schemastery-like: validação de esquemas com inferência de tipos.
 * Implementação própria (sem dependências), subset suficiente para o harness:
 * any/string/number/boolean/literal/array/object/record/union + optional/default.
 */

import { deepClone, isPlainObject } from '@open-harness/cosmokit'

// ---------------------------------------------------------------------------
// Erros
// ---------------------------------------------------------------------------

export interface Issue {
  path: string
  message: string
}

export class SchemaError extends Error {
  readonly issues: Issue[]

  constructor(issues: Issue[]) {
    super(formatIssues(issues))
    this.name = 'SchemaError'
    this.issues = issues
  }
}

export function formatIssues(issues: Issue[]): string {
  if (!issues.length) return 'invalid value'
  return issues
    .map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message))
    .join('; ')
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; issues: Issue[] }

// ---------------------------------------------------------------------------
// Inferência de tipos
// ---------------------------------------------------------------------------

export type Infer<S> = S extends Schema<infer T> ? T : never

type Simplify<T> = { [K in keyof T]: T[K] } & {}

type OptionalOf<S> = S extends OptionalSchema<infer U> ? U : never

export type ObjectOutput<S extends Record<string, Schema<any>>> = Simplify<
  { [K in keyof S as S[K] extends OptionalSchema<any> ? never : K]: Infer<S[K]> } & {
    [K in keyof S as S[K] extends OptionalSchema<any> ? K : never]?: OptionalOf<S[K]>
  }
>

// ---------------------------------------------------------------------------
// Base
// ---------------------------------------------------------------------------

export abstract class Schema<T = unknown> {
  /** Nome do construtor — usado em mensagens de erro. */
  abstract readonly kind: string
  description?: string

  /**
   * Converte/valida `value`, empurrando issues em `issues`.
   * Chamado por outras instâncias de Schema (API interna pública de propósito).
   */
  abstract check(value: unknown, path: string, issues: Issue[]): T

  validate(value: unknown, path = ''): ValidationResult<T> {
    const issues: Issue[] = []
    const result = this.check(value, path, issues)
    if (issues.length) return { ok: false, issues }
    return { ok: true, value: result }
  }

  /** Valida e lança `SchemaError` em caso de falha. */
  parse(value: unknown, path = ''): T {
    const result = this.validate(value, path)
    if (!result.ok) throw new SchemaError(result.issues)
    return result.value
  }

  /** Torna o valor opcional (`undefined` é aceito e a chave pode faltar). */
  optional(): OptionalSchema<T> {
    return new OptionalSchema<T>(this)
  }

  /** Fornece um valor quando a entrada é `undefined`. */
  default(value: T): DefaultSchema<T> {
    return new DefaultSchema<T>(this, value)
  }

  /** Documenta o esquema (retorna `this`, mutável por design). */
  describe(text: string): this {
    this.description = text
    return this
  }
}

export class OptionalSchema<T> extends Schema<T | undefined> {
  readonly kind = 'optional'
  constructor(readonly inner: Schema<T>) {
    super()
  }

  check(value: unknown, path: string, issues: Issue[]): T | undefined {
    if (value === undefined) return undefined
    return this.inner.check(value, path, issues)
  }
}

export class DefaultSchema<T> extends Schema<T> {
  readonly kind = 'default'
  constructor(
    readonly inner: Schema<T>,
    readonly defaultValue: T,
  ) {
    super()
  }

  check(value: unknown, path: string, issues: Issue[]): T {
    if (value === undefined) return deepClone(this.defaultValue)
    return this.inner.check(value, path, issues)
  }
}

function fail(issues: Issue[], path: string, message: string): never {
  issues.push({ path, message })
  return undefined as never
}

function typeName(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (value instanceof Date) return 'date'
  return typeof value
}

// ---------------------------------------------------------------------------
// Primitivos
// ---------------------------------------------------------------------------

export class AnySchema<T = unknown> extends Schema<T> {
  readonly kind = 'any'
  check(value: unknown): T {
    return value as T
  }
}

export interface StringOptions {
  min?: number
  max?: number
  pattern?: RegExp
}

export class StringSchema extends Schema<string> {
  readonly kind = 'string'
  constructor(readonly options: StringOptions = {}) {
    super()
  }

  check(value: unknown, path: string, issues: Issue[]): string {
    if (typeof value !== 'string') return fail(issues, path, `expected string, got ${typeName(value)}`)
    const { min, max, pattern } = this.options
    if (min !== undefined && value.length < min) fail(issues, path, `must be at least ${min} characters`)
    if (max !== undefined && value.length > max) fail(issues, path, `must be at most ${max} characters`)
    if (pattern && !pattern.test(value)) fail(issues, path, `must match ${String(pattern)}`)
    return value
  }
}

export interface NumberOptions {
  int?: boolean
  min?: number
  max?: number
}

export class NumberSchema extends Schema<number> {
  readonly kind = 'number'
  constructor(readonly options: NumberOptions = {}) {
    super()
  }

  check(value: unknown, path: string, issues: Issue[]): number {
    if (typeof value !== 'number' || Number.isNaN(value)) {
      return fail(issues, path, `expected number, got ${typeName(value)}`)
    }
    const { int, min, max } = this.options
    if (int && !Number.isInteger(value)) fail(issues, path, 'expected integer')
    if (min !== undefined && value < min) fail(issues, path, `must be >= ${min}`)
    if (max !== undefined && value > max) fail(issues, path, `must be <= ${max}`)
    return value
  }

  /** Exige inteiro (encadeável): `s.number().int()`. */
  int(): this {
    this.options.int = true
    return this
  }
}

export class BooleanSchema extends Schema<boolean> {
  readonly kind = 'boolean'
  check(value: unknown, path: string, issues: Issue[]): boolean {
    if (typeof value !== 'boolean') return fail(issues, path, `expected boolean, got ${typeName(value)}`)
    return value
  }
}

export class LiteralSchema<T extends string | number | boolean | null> extends Schema<T> {
  readonly kind = 'literal'
  constructor(readonly literal: T) {
    super()
  }

  check(value: unknown, path: string, issues: Issue[]): T {
    if (value !== this.literal) {
      return fail(issues, path, `expected ${JSON.stringify(this.literal)}`)
    }
    return this.literal
  }
}

// ---------------------------------------------------------------------------
// Coleções
// ---------------------------------------------------------------------------

export interface ArrayOptions {
  min?: number
  max?: number
}

export class ArraySchema<T> extends Schema<T[]> {
  readonly kind = 'array'
  constructor(
    readonly item: Schema<T>,
    readonly options: ArrayOptions = {},
  ) {
    super()
  }

  check(value: unknown, path: string, issues: Issue[]): T[] {
    if (!Array.isArray(value)) return fail(issues, path, `expected array, got ${typeName(value)}`)
    const { min, max } = this.options
    if (min !== undefined && value.length < min) fail(issues, path, `must contain at least ${min} items`)
    if (max !== undefined && value.length > max) fail(issues, path, `must contain at most ${max} items`)
    return value.map((item, index) => this.item.check(item, childIndexPath(path, index), issues))
  }
}

export type ObjectMode = 'passthrough' | 'strip' | 'forbid'

export interface ObjectOptions {
  /** O que fazer com chaves ausentes do shape. Default: `passthrough`. */
  additional?: ObjectMode
}

export class ObjectSchema<S extends Record<string, Schema<any>>> extends Schema<ObjectOutput<S>> {
  readonly kind = 'object'
  readonly mode: ObjectMode

  constructor(
    readonly shape: S,
    readonly options: ObjectOptions = {},
  ) {
    super()
    this.mode = options.additional ?? 'passthrough'
  }

  check(value: unknown, path: string, issues: Issue[]): ObjectOutput<S> {
    if (!isPlainObject(value)) return fail(issues, path, `expected object, got ${typeName(value)}`)
    const out: Record<string, unknown> = {}
    const shapeKeys = new Set(Object.keys(this.shape))
    for (const [key, schema] of Object.entries(this.shape)) {
      const childPath = childKeyPath(path, key)
      const has = Object.prototype.hasOwnProperty.call(value, key)
      const raw = has ? value[key] : undefined
      if (!has) {
        // Opcional ausente → a chave simplesmente não existe no resultado.
        if (schema instanceof OptionalSchema) continue
        // Exigida e ausente → delega ao filho (ele reporta
        // "expected string, got undefined") e a chave é materializada.
        out[key] = schema.check(raw, childPath, issues)
        continue
      }
      out[key] = schema.check(raw, childPath, issues)
    }
    for (const key of Object.keys(value)) {
      if (shapeKeys.has(key)) continue
      if (this.mode === 'passthrough') out[key] = value[key]
      else if (this.mode === 'forbid') issues.push({ path: childKeyPath(path, key), message: 'unknown key' })
    }
    return out as ObjectOutput<S>
  }
}

export class RecordSchema<T> extends Schema<Record<string, T>> {
  readonly kind = 'record'
  constructor(readonly value: Schema<T>) {
    super()
  }

  check(value: unknown, path: string, issues: Issue[]): Record<string, T> {
    if (!isPlainObject(value)) return fail(issues, path, `expected object, got ${typeName(value)}`)
    const out: Record<string, T> = {}
    for (const [key, item] of Object.entries(value)) {
      out[key] = this.value.check(item, childKeyPath(path, key), issues)
    }
    return out
  }
}

export class UnionSchema<T> extends Schema<T> {
  readonly kind = 'union'
  constructor(readonly variants: Schema<any>[]) {
    super()
  }

  check(value: unknown, path: string, issues: Issue[]): T {
    const collected: Issue[] = []
    for (const variant of this.variants) {
      const local: Issue[] = []
      const parsed = variant.check(value, path, local)
      if (!local.length) return parsed as T
      collected.push(...local)
    }
    issues.push({ path, message: `does not match any variant (${collected.map((i) => i.message).join(' | ')})` })
    return undefined as never
  }
}

function childKeyPath(path: string, key: string): string {
  return path ? `${path}.${key}` : key
}

function childIndexPath(path: string, index: number): string {
  return `${path}[${index}]`
}

// ---------------------------------------------------------------------------
// Fábricas
// ---------------------------------------------------------------------------

export const s = {
  any<T = unknown>(): AnySchema<T> {
    return new AnySchema<T>()
  },
  unknown(): AnySchema<unknown> {
    return new AnySchema<unknown>()
  },
  string(options: StringOptions = {}): StringSchema {
    return new StringSchema(options)
  },
  number(options: NumberOptions = {}): NumberSchema {
    return new NumberSchema(options)
  },
  int(options: Omit<NumberOptions, 'int'> = {}): NumberSchema {
    return new NumberSchema({ ...options, int: true })
  },
  boolean(): BooleanSchema {
    return new BooleanSchema()
  },
  literal<T extends string | number | boolean | null>(value: T): LiteralSchema<T> {
    return new LiteralSchema(value)
  },
  array<T>(item: Schema<T>, options: ArrayOptions = {}): ArraySchema<T> {
    return new ArraySchema(item, options)
  },
  object<S extends Record<string, Schema<any>>>(shape: S, options: ObjectOptions = {}): ObjectSchema<S> {
    return new ObjectSchema(shape, options)
  },
  record<T>(value: Schema<T>): RecordSchema<T> {
    return new RecordSchema(value)
  },
  union<T extends readonly [Schema<any>, ...Schema<any>[]]>(variants: T): UnionSchema<Infer<T[number]>> {
    return new UnionSchema<Infer<T[number]>>([...variants])
  },
} as const

export default s
