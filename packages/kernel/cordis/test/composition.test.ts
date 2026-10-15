import { describe, expect, it } from 'vitest'
import { sleep } from '@open-harness/cosmokit'
import {
  Context,
  DisposedError,
  InvalidPluginError,
  ServiceConflictError,
  ServiceUnavailableError,
} from '@open-harness/cordis'

/**
 * Critério de aceite da FASE 0:
 * um "hello plugin" compõe 3 plugins com injeção e dispose correcto.
 */
describe('composição hello-plugin (3 plugins)', () => {
  function buildHello() {
    const applied: string[] = []
    const disposed: string[] = []
    let captured: string | undefined

    const greeter = {
      name: 'greeter',
      apply(ctx: Context) {
        ctx.set('greeting', 'hello')
        ctx.effect(() => () => {
          disposed.push('greeter')
        })
        applied.push('greeter')
      },
    }

    const formatter = {
      name: 'formatter',
      inject: ['greeting'],
      apply(ctx: Context) {
        ctx.set('message', `${ctx.get<string>('greeting')}, world`)
        ctx.effect(() => () => {
          disposed.push('formatter')
        })
        applied.push('formatter')
      },
    }

    const printer = {
      name: 'printer',
      inject: ['message'],
      apply(ctx: Context) {
        captured = ctx.get<string>('message')
        ctx.effect(() => () => {
          disposed.push('printer')
        })
        applied.push('printer')
      },
    }

    return { greeter, formatter, printer, applied, disposed, read: () => captured }
  }

  it('activa por disponibilidade de serviços, mesmo registado em ordem inversa', async () => {
    const root = new Context()
    const hello = buildHello()

    // Registado ao contrário da dependência — a activação não depende da ordem.
    const printer = root.plugin(hello.printer)
    const formatter = root.plugin(hello.formatter)
    const greeter = root.plugin(hello.greeter)
    await Promise.all([printer, formatter, greeter])

    expect(hello.read()).toBe('hello, world')
    // A ordem de aplicação segue as dependências, não a ordem de registo.
    expect(hello.applied).toEqual(['greeter', 'formatter', 'printer'])
    expect(root.children).toHaveLength(3)
    expect(root.listServices()).toEqual(expect.arrayContaining(['greeting', 'message']))
    expect(root.children.every((child) => child.status === 'active')).toBe(true)
  })

  it('dispose: dependentes primeiro (LIFO), serviços removidos e árvore limpa', async () => {
    const root = new Context()
    const hello = buildHello()

    await Promise.all([
      root.plugin(hello.greeter),
      root.plugin(hello.formatter),
      root.plugin(hello.printer),
    ])
    expect(hello.read()).toBe('hello, world')

    await root.dispose()

    expect(hello.disposed).toEqual(['printer', 'formatter', 'greeter'])
    expect(root.has('greeting')).toBe(false)
    expect(root.has('message')).toBe(false)
    expect(root.children).toHaveLength(0)
    expect(root.status).toBe('disposed')
    // idempotente
    await root.dispose()
    expect(hello.disposed).toEqual(['printer', 'formatter', 'greeter'])
  })

  it('serviços chegam depois: o plugin fica pendente e activa no set', async () => {
    const root = new Context()
    let applied = false

    const pending = root.plugin({
      name: 'late',
      inject: ['later'],
      apply() {
        applied = true
      },
    })

    const raced = await Promise.race([
      pending.then(() => 'active'),
      sleep(25).then(() => 'still-pending'),
    ])
    expect(raced).toBe('still-pending')
    expect(applied).toBe(false)
    expect(root.children[0]?.status).toBe('idle')

    root.set('later', 42)
    await pending
    expect(applied).toBe(true)
    expect(root.children[0]?.status).toBe('active')
  })

  it('inject opcional não bloqueia a activação', async () => {
    const root = new Context()
    let applied = false
    const promise = root.plugin({
      name: 'with-optional',
      inject: { required: ['need'], optional: ['never-appears'] },
      apply() {
        applied = true
      },
    })

    await sleep(5)
    expect(root.children[0]?.status).toBe('idle') // continua à espera do obrigatório
    expect(applied).toBe(false)

    root.set('need', true)
    await promise // activa mesmo sem o serviço opcional nunca existir
    expect(applied).toBe(true)
    expect(root.children[0]?.status).toBe('active')
  })

  it('rejeita quando a fibra morre à espera de um serviço', async () => {
    const root = new Context()
    const promise = root.plugin({ name: 'waiting', inject: ['never'], apply() {} })
    const waiting = root.children[0]!
    expect(waiting.status).toBe('idle')

    await waiting.dispose()
    await expect(promise).rejects.toThrow(DisposedError)
    expect(waiting.status).toBe('disposed')
  })

  it('apply que lança desfaz a fibra e propaga o erro', async () => {
    const root = new Context()
    let cleaned = false
    const failure = root.plugin({
      name: 'boom',
      apply(ctx: Context) {
        ctx.effect(() => () => {
          cleaned = true
        })
        throw new Error('apply failed')
      },
    })

    let caught: (Error & { context?: { status: string; pluginName?: string } }) | undefined
    await failure.catch((error: Error & { context?: { status: string; pluginName?: string } }) => {
      caught = error
    })

    expect(caught?.message).toBe('apply failed')
    expect(caught?.context?.status).toBe('failed')
    expect(caught?.context?.pluginName).toBe('boom')
    expect(cleaned).toBe(true)
    // fibra desfeita e desanexada da árvore
    expect(root.children).toHaveLength(0)
  })

  it('dois provedores no mesmo slot lançam ServiceConflictError', async () => {
    const root = new Context()
    await root.plugin({ name: 'first', apply: (ctx) => ctx.set('solo', 1) })
    await expect(
      root.plugin({ name: 'second', apply: (ctx) => ctx.set('solo', 2) }),
    ).rejects.toThrow(ServiceConflictError)
    expect(root.get('solo')).toBe(1)
    // o slot múltiplo acumula
    root.provide('hooks', { multiple: true })
    await root.plugin({ name: 'a', apply: (ctx) => ctx.set('hooks', 'a') })
    await root.plugin({ name: 'b', apply: (ctx) => ctx.set('hooks', 'b') })
    expect(root.getAll('hooks')).toEqual(['a', 'b'])
  })

  it('get inexistente lança ServiceUnavailableError e dispose bloqueia novos registros', async () => {
    const root = new Context()
    expect(() => root.get('nope')).toThrow(ServiceUnavailableError)
    expect(root.has('nope')).toBe(false)

    await root.dispose()
    expect(() => root.fork('x')).toThrow(DisposedError)
    await expect(root.plugin({ apply() {} })).rejects.toThrow(DisposedError)
    expect(() => root.effect(() => noop2)).toThrow(DisposedError)
  })

  it('rejeita definição de plugin inválida', async () => {
    const root = new Context()
    await expect(root.plugin({ name: 'bad' } as never)).rejects.toThrow(InvalidPluginError)
    expect(root.children).toHaveLength(0)
  })
})

function noop2(): void {}
