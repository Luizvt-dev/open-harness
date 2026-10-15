/**
 * Utilidades básicas compartilhadas por todo o harness.
 * Sem dependências externas.
 */

export type Disposer = () => void | Promise<void>

/** Função vazia — usada como default de callbacks opcionais. */
export function noop(): void {}

/** Verifica se o valor é um objeto "plano" (literal `{}` ou `Object.create(null)`). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const proto = Object.getPrototypeOf(value) as unknown
  return proto === Object.prototype || proto === null
}

/** Igualdade profunda para dados JSON-ish (primitivos, arrays, objetos planos, Date, Map, Set). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return false
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime()
  if (a instanceof Date || b instanceof Date) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    return a.every((item, i) => deepEqual(item, b[i]))
  }
  if (Array.isArray(a) || Array.isArray(b)) return false
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false
    for (const [key, value] of a) {
      if (!b.has(key) || !deepEqual(value, b.get(key))) return false
    }
    return true
  }
  if (a instanceof Set && b instanceof Set) {
    if (a.size !== b.size) return false
    for (const value of a) if (!b.has(value)) return false
    return true
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false
  const keysA = Object.keys(a)
  const keysB = Object.keys(b)
  if (keysA.length !== keysB.length) return false
  return keysA.every((key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]))
}

/**
 * Cópia profunda de dados JSON-ish. Funções e outros objetos não clonáveis são
 * compartilhados por referência (nunca lançamos, diferente de `structuredClone`).
 */
export function deepClone<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  if (value instanceof Date) return new Date(value.getTime()) as T
  if (Array.isArray(value)) return value.map((item) => deepClone(item)) as T
  if (value instanceof Map) {
    const out = new Map()
    for (const [key, item] of value) out.set(deepClone(key), deepClone(item))
    return out as T
  }
  if (value instanceof Set) {
    const out = new Set()
    for (const item of value) out.add(deepClone(item))
    return out as T
  }
  if (!isPlainObject(value)) return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value)) out[key] = deepClone(value[key])
  return out as T
}

/** Normaliza `valor | valor[] | undefined` para sempre um array. */
export function ensureArray<T>(value: T | readonly T[] | undefined | null): T[] {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? [...value] : [value as T]
}

/** Espera `ms` milissegundos. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Promise com resolve/rejoin expostos. */
export class Deferred<T = void> {
  readonly promise: Promise<T>
  resolve!: (value: T | PromiseLike<T>) => void
  reject!: (reason?: unknown) => void
  settled = false

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = (value) => {
        if (this.settled) return
        this.settled = true
        resolve(value)
      }
      this.reject = (reason) => {
        if (this.settled) return
        this.settled = true
        reject(reason)
      }
    })
    // Evita "unhandled rejection" quando só existe produtor interessado.
    this.promise.catch(noop)
  }
}

/** Garante que uma função seja chamada no máximo uma vez. */
export function once<T extends (...args: never[]) => unknown>(fn: T): T {
  let called = false
  return ((...args: never[]) => {
    if (called) return undefined
    called = true
    return fn(...args)
  }) as T
}
