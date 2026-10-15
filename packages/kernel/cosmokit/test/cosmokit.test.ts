import { describe, expect, it } from 'vitest'
import { Deferred, deepClone, deepEqual, ensureArray, isPlainObject, once } from '@open-harness/cosmokit'

describe('isPlainObject', () => {
  it('aceita literais e null-proto', () => {
    expect(isPlainObject({})).toBe(true)
    expect(isPlainObject(Object.create(null))).toBe(true)
    expect(isPlainObject([])).toBe(false)
    expect(isPlainObject(new Date())).toBe(false)
    expect(isPlainObject(null)).toBe(false)
    expect(isPlainObject('x')).toBe(false)
  })
})

describe('deepEqual', () => {
  it('compara estruturas profundas', () => {
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true)
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false)
    expect(deepEqual([1, 2], [2, 1])).toBe(false)
    expect(deepEqual(new Date(5), new Date(5))).toBe(true)
    expect(deepEqual(new Map([['k', 1]]), new Map([['k', 1]]))).toBe(true)
    expect(deepEqual(new Set([1]), new Set([1, 2]))).toBe(false)
    expect(deepEqual({ a: 1 }, { a: 1.0 })).toBe(true)
  })
})

describe('deepClone', () => {
  it('copia estruturas sem partilhar referências', () => {
    const source = { a: { b: [1, 2] }, d: new Date(5) }
    const copy = deepClone(source)
    expect(copy).toEqual(source)
    expect(copy.a).not.toBe(source.a)
    expect(copy.a.b).not.toBe(source.a.b)
    expect(copy.d).not.toBe(source.d)
    expect(copy.d.getTime()).toBe(5)
  })

  it('preserva funções por referência', () => {
    const fn = () => 1
    const copy = deepClone({ fn })
    expect(copy.fn).toBe(fn)
  })
})

describe('ensureArray', () => {
  it('normaliza valores', () => {
    expect(ensureArray(1)).toEqual([1])
    expect(ensureArray([1, 2])).toEqual([1, 2])
    expect(ensureArray(undefined)).toEqual([])
    expect(ensureArray(null)).toEqual([])
  })
})

describe('Deferred', () => {
  it('resolve uma vez e ignora chamadas seguintes', async () => {
    const d = new Deferred<number>()
    d.resolve(1)
    d.resolve(2)
    await expect(d.promise).resolves.toBe(1)
    expect(d.settled).toBe(true)
  })
})

describe('once', () => {
  it('só executa a primeira chamada', () => {
    let count = 0
    const fn = once(() => ++count)
    expect(fn()).toBe(1)
    expect(fn()).toBeUndefined()
    expect(count).toBe(1)
  })
})
