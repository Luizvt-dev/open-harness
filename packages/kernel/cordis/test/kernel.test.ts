import { describe, expect, it, vi } from 'vitest'
import { Context, CordisError, createApp, type ServiceEvent } from '@open-harness/cordis'

describe('eventos', () => {
  it('emit desce a árvore; emit de filho não sobe', () => {
    const root = new Context()
    const child = root.fork('child')
    const grandchild = child.fork('grandchild')
    const seen: string[] = []

    root.on('tick', (n: number) => seen.push(`root:${n}`))
    child.on('tick', (n: number) => seen.push(`child:${n}`))
    grandchild.on('tick', (n: number) => seen.push(`grandchild:${n}`))

    child.emit('tick', 1)
    expect(seen).toEqual(['child:1', 'grandchild:1']) // não sobe para root

    root.emit('tick', 2)
    expect(seen).toEqual(['child:1', 'grandchild:1', 'root:2', 'child:2', 'grandchild:2'])
  })

  it('once dispara uma vez e é removido do registo', () => {
    const root = new Context()
    const spy = vi.fn()
    root.on('go', spy, { once: true })
    root.emit('go')
    root.emit('go')
    expect(spy).toHaveBeenCalledTimes(1)

    const off = root.on('stay', spy)
    root.emit('stay')
    off()
    root.emit('stay')
    expect(spy).toHaveBeenCalledTimes(2)
    expect(root.hasListener('stay')).toBe(false)
  })

  it('eventos são removidos no dispose da fibra', async () => {
    const root = new Context()
    const child = root.fork('c')
    const spy = vi.fn()
    child.on('x', spy)
    await child.dispose()
    root.emit('x')
    expect(spy).not.toHaveBeenCalled()
  })

  it('erro num listener vai para o listener `error` da raiz', () => {
    const root = new Context()
    const errors: unknown[] = []
    root.on('error', (error: unknown) => errors.push(error))

    const child = root.fork('bad')
    child.on('tick', () => {
      throw new Error('listener exploded')
    })

    expect(() => root.emit('tick')).not.toThrow()
    expect(errors).toHaveLength(1)
    expect((errors[0] as Error).message).toBe('listener exploded')
  })
})

describe('waterfall', () => {
  it('encadeia valores em pre-order (nó → filhos)', () => {
    const root = new Context()
    const a = root.fork('a')
    const b = a.fork('b')

    root.on('config', (value: string) => `${value}+root`)
    a.on('config', (value: string) => `${value}+a`)
    b.on('config', (value: string) => `${value}+b`)

    expect(root.waterfall('config', 'base')).toBe('base+root+a+b')
    // começar num subnodo só percorre a sub-árvore
    expect(a.waterfall('config', 'base')).toBe('base+a+b')
  })

  it('suporta argumentos extras e `order`', () => {
    const root = new Context()
    root.on('sum', (value: number, n: number) => value + n, { order: 2 })
    root.on('sum', (value: number, n: number) => value * n, { order: 1 })
    expect(root.waterfall('sum', 3, 2)).toBe(8) // *(order 1) depois +(order 2)
  })

  it('listener assíncrono é rejeitado', () => {
    const root = new Context()
    root.on('async', async (value: string) => value)
    expect(() => root.waterfall('async', 'x')).toThrow(CordisError)
  })
})

describe('serviços', () => {
  it('eventos available/lost são emitidos na raiz e alcançam todos os ramos', async () => {
    const root = new Context()
    const side = root.fork('side')
    const events: string[] = []
    side.on('service', (event: ServiceEvent) => events.push(`${event.type}:${event.name}`))

    const provider = root.fork('provider')
    provider.set('db', { url: 'x' })
    expect(events).toEqual(['available:db'])

    await provider.dispose()
    expect(events).toEqual(['available:db', 'lost:db'])
    expect(root.has('db')).toBe(false)
  })

  it('unset/remove são observáveis e o dispose da fibra limpa o slot', async () => {
    const root = new Context()
    const fiber = root.fork('f')
    fiber.set('token', 'abc')
    expect(root.get('token')).toBe('abc')

    expect(fiber.unset('token')).toBe(true)
    expect(fiber.unset('token')).toBe(false)
    expect(root.has('token')).toBe(false)

    fiber.set('other', 1)
    await fiber.dispose()
    expect(root.has('other')).toBe(false)
    expect(root.listServices()).toContain('other') // slot declarado permanece
  })

  it('re-set na mesma fibra substitui sem conflito', async () => {
    const root = new Context()
    root.set('cfg', 1)
    root.set('cfg', 2)
    expect(root.get('cfg')).toBe(2)
    await root.dispose()
    expect(root.has('cfg')).toBe(false)
  })
})

describe('estrutura', () => {
  it('createApp devolve raiz com caminho e estado inicial', () => {
    const app = createApp('dsh')
    expect(app.path).toBe('dsh')
    expect(app.root).toBe(app)
    expect(app.status).toBe('idle')
    expect(app.parent).toBeNull()
  })

  it('dispose de um filho não afeta os irmãos', async () => {
    const root = new Context()
    const a = root.fork('a')
    const b = root.fork('b')
    await a.dispose()
    expect(root.children).toHaveLength(1)
    expect(root.children[0]).toBe(b)
    expect(b.fiber.disposed).toBe(false)
  })
})
