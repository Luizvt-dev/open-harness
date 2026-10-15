import { noop, type Disposer } from '@open-harness/cosmokit'
import { CordisError, DisposedError, ServiceConflictError, ServiceUnavailableError } from './errors.js'
import { Fiber } from './fiber.js'
import { normalizePlugin } from './plugin.js'
import type { ContextStatus, EventName, Listener, Plugin, ServiceEvent, WaterfallListener } from './types.js'

interface ServiceSlot {
  name: string
  multiple: boolean
  /** value por fibra provedora; Map preserva ordem de registro. */
  values: Map<Fiber, unknown>
}

interface ListenerEntry {
  listener: Listener
  once: boolean
  order: number
  seq: number
  remove: Disposer
}

export interface ContextOptions {
  parent?: Context
  name?: string
}

export interface InjectOptions {
  once?: boolean
  /** Menor primeiro — útil para waterfalls com pré/pós-processadores. */
  order?: number
}

let reportingError = false

/**
 * Nó da árvore de composição. Cada Contexto possui exatamente uma `Fiber`
 * (unidade de dispose dos efeitos) e participa de:
 *
 * - **serviços** (`provide/set/get/has`) — registry global da raiz com
 *   propriedade por fibra; remover a fibra remove o serviço;
 * - **ativação por disponibilidade** — `plugin({ inject })` só aplica quando os
 *   serviços obrigatórios existirem, independentemente da ordem das linhas;
 * - **eventos** (`on/emit/waterfall`) — `emit` desce a árvore; eventos de
 *   serviço são emitidos na raiz para alcançar todos os ramos.
 */
export class Context {
  readonly name: string
  readonly parent: Context | null
  readonly path: string
  readonly root: Context
  readonly fiber: Fiber
  /** Filhos em ordem de criação. */
  readonly children: Context[] = []
  status: ContextStatus = 'idle'
  /** Nome do plugin que originou esta fibra (diagnóstico). */
  pluginName?: string

  private readonly listeners = new Map<EventName, ListenerEntry[]>()
  /** Slots de serviço — consultados sempre via `this.root.slots`. */
  private readonly slots = new Map<string, ServiceSlot>()
  private listenerSeq = 0

  constructor(options: ContextOptions = {}) {
    const parent = options.parent ?? null
    this.parent = parent
    this.name = options.name ?? (parent ? 'fiber' : 'root')
    this.path = parent ? `${parent.path}.${this.name}` : this.name
    this.root = parent ? parent.root : this
    this.fiber = new Fiber(this, parent ? parent.fiber : null)
    if (parent) parent.children.push(this)
  }

  // -------------------------------------------------------------------------
  // Estrutura
  // -------------------------------------------------------------------------

  /** Cria uma fibra filha (dispose isolado do resto da árvore). */
  fork(name = 'fiber'): Context {
    this.assertLive()
    return new Context({ parent: this, name })
  }

  /**
   * Registra um plugin numa fibra nova e aplica quando os serviços injetados
   * estiverem disponíveis (a ordem das chamadas não importa).
   * Rejeita se o `apply` lançar (a fibra é desfeita) ou se a fibra morrer à espera.
   */
  async plugin<C = any>(def: Plugin<C>, config?: C): Promise<Context> {
    this.assertLive()
    const normalized = normalizePlugin(def)
    const ctx = this.fork(normalized.name ?? 'plugin')
    ctx.pluginName = normalized.name

    const satisfied = () => normalized.required.every((name) => ctx.has(name))
    if (!satisfied()) {
      await new Promise<void>((resolve, reject) => {
        const offService = ctx.on('service', (event: ServiceEvent) => {
          if (event.type === 'available' && satisfied()) {
            offService()
            offDispose()
            resolve()
          }
        })
        const offDispose = ctx.on('dispose', () => {
          offService()
          reject(new DisposedError(ctx.path))
        })
      })
    }

    ctx.status = 'active'
    try {
      await normalized.apply(ctx, config)
    } catch (error) {
      await ctx.dispose()
      ctx.status = 'failed'
      // Diagnóstico: quem falhou e em que fibra, sem esconder o erro original.
      if (error instanceof Error && !('context' in error)) {
        try {
          Object.defineProperty(error, 'context', {
            value: ctx,
            configurable: true,
            enumerable: false,
            writable: false,
          })
        } catch {
          /* erro selado — segue sem o anexo */
        }
      }
      throw error
    }
    return ctx
  }

  /** Remove a fibra e todos os descendentes. Idempotente. */
  dispose(): Promise<void> {
    return this.fiber.dispose()
  }

  // -------------------------------------------------------------------------
  // Efeitos e eventos
  // -------------------------------------------------------------------------

  /**
   * Registra um efeito de vida útil ligado à fibra: `ctx.effect(() => () => cleanup)`.
   * O retorno (se for função) roda no dispose, em LIFO. Devolve disposer idempotente.
   */
  effect(register: () => void | Disposer): Disposer {
    this.assertLive()
    const result = register()
    if (typeof result === 'function') return this.fiber.add(result)
    return noop
  }

  /**
   * Assina um evento desta sub-árvore (o `emit` daqui alcança descendentes).
   * O listener é removido automaticamente no dispose da fibra.
   */
  on(event: EventName, listener: Listener, options: InjectOptions = {}): Disposer {
    this.assertLive()
    let entries = this.listeners.get(event)
    if (!entries) {
      entries = []
      this.listeners.set(event, entries)
    }
    const entry: ListenerEntry = {
      listener,
      once: options.once ?? false,
      order: options.order ?? 0,
      seq: this.listenerSeq++,
      remove: noop,
    }
    entries.push(entry)
    entries.sort((a, b) => a.order - b.order || a.seq - b.seq)
    entry.remove = this.effect(() => () => {
      const index = entries.indexOf(entry)
      if (index >= 0) entries.splice(index, 1)
    })
    return entry.remove
  }

  /** Emite um evento descendo por esta sub-árvore (sincrono). */
  emit(event: EventName, ...args: unknown[]): this {
    this.dispatch(event, args)
    return this
  }

  /** Existe algum listener para `event` neste nó? */
  hasListener(event: EventName): boolean {
    return (this.listeners.get(event)?.length ?? 0) > 0
  }

  /**
   * Encadeia o valor pelos listeners do evento (pre-order: este nó → filhos).
   * Síncrono de propósito: um listener que devolver promise lança `CordisError`.
   */
  waterfall<T>(event: EventName, initial: T, ...args: unknown[]): T {
    let value = initial
    const visit = (ctx: Context): void => {
      const entries = ctx.listeners.get(event)
      if (entries) {
        for (const entry of [...entries]) {
          if (!entries.includes(entry)) continue
          if (entry.once) entry.remove()
          const listener = entry.listener as unknown as WaterfallListener<T>
          const next: unknown = listener(value, ...args)
          if (next && typeof (next as { then?: unknown }).then === 'function') {
            throw new CordisError(`waterfall listener for "${String(event)}" must be synchronous`)
          }
          value = next as T
        }
      }
      for (const child of [...ctx.children]) visit(child)
    }
    visit(this)
    return value
  }

  // -------------------------------------------------------------------------
  // Serviços
  // -------------------------------------------------------------------------

  /**
   * Declara um slot de serviço (idempotente). Sem `multiple`, um único fibra
   * pode prover o slot; com `multiple`, `set` acumula e `getAll` devolve todos.
   */
  provide(name: string, options: { multiple?: boolean } = {}): this {
    this.assertLive()
    this.slotFor(name, options.multiple)
    return this
  }

  /** Prove um serviço a partir desta fibra; some no dispose dela. */
  set(name: string, value: unknown): this {
    this.assertLive()
    const slot = this.slotFor(name)
    if (!slot.multiple) {
      for (const owner of slot.values.keys()) {
        if (owner !== this.fiber) {
          throw new ServiceConflictError(
            `service "${name}" is already provided by ${owner.context.path}`,
          )
        }
      }
    }
    const had = slot.values.has(this.fiber)
    const previous = slot.values.get(this.fiber)
    slot.values.set(this.fiber, value)
    this.effect(() => () => {
      if (slot.values.get(this.fiber) !== value) return
      slot.values.delete(this.fiber)
      this.root.dispatch('service', [{ name, type: 'lost', value } satisfies ServiceEvent])
    })
    if (!had || previous !== value) {
      this.root.dispatch('service', [{ name, type: 'available', value } satisfies ServiceEvent])
    }
    return this
  }

  /** Remove a contribuição desta fibra ao serviço. */
  unset(name: string): boolean {
    const slot = this.root.slots.get(name)
    if (!slot || !slot.values.has(this.fiber)) return false
    slot.values.delete(this.fiber)
    this.root.dispatch('service', [{ name, type: 'lost' } satisfies ServiceEvent])
    return true
  }

  /** Valor corrente do serviço (o mais recente, se `multiple`). Lança se indisponível. */
  get<T = unknown>(name: string): T {
    const slot = this.root.slots.get(name)
    if (!slot || slot.values.size === 0) throw new ServiceUnavailableError(name)
    let last: unknown
    for (const value of slot.values.values()) last = value
    return last as T
  }

  /** Todos os valores de um slot `multiple` (vazio se ninguém prover). */
  getAll<T = unknown>(name: string): T[] {
    const slot = this.root.slots.get(name)
    return slot ? ([...slot.values.values()] as T[]) : []
  }

  /** O serviço tem valor corrente? */
  has(name: string): boolean {
    const slot = this.root.slots.get(name)
    return slot !== undefined && slot.values.size > 0
  }

  /** Nomes de slots declarados/registrados. */
  listServices(): string[] {
    return [...this.root.slots.keys()]
  }

  // -------------------------------------------------------------------------
  // Interno (usado pela Fiber)
  // -------------------------------------------------------------------------

  /** @internal */
  assertLive(): void {
    if (this.fiber.disposed) throw new DisposedError(this.path)
  }

  /** @internal Dispara `dispose` apenas neste nó. */
  notifyDispose(): void {
    this.dispatchHere('dispose', [])
  }

  /** @internal Reporta erro de listener/efeito para o listeners `error` da raiz. */
  reportError(error: unknown): void {
    const root = this.root
    if (!reportingError && root.hasListener('error')) {
      reportingError = true
      try {
        root.dispatch('error', [error])
      } catch (secondary) {
        console.error(secondary)
      } finally {
        reportingError = false
      }
      return
    }
    console.error(error)
  }

  // -------------------------------------------------------------------------
  // Privados
  // -------------------------------------------------------------------------

  private slotFor(name: string, multiple?: boolean): ServiceSlot {
    const existing = this.root.slots.get(name)
    if (!existing) {
      const slot: ServiceSlot = { name, multiple: multiple ?? false, values: new Map() }
      this.root.slots.set(name, slot)
      return slot
    }
    if (multiple !== undefined && multiple !== existing.multiple) {
      throw new ServiceConflictError(
        `service "${name}" is already registered as ${existing.multiple ? 'multiple' : 'single'}`,
      )
    }
    return existing
  }

  private dispatch(event: EventName, args: unknown[]): void {
    this.dispatchHere(event, args)
    for (const child of [...this.children]) child.dispatch(event, args)
  }

  private dispatchHere(event: EventName, args: unknown[]): void {
    const entries = this.listeners.get(event)
    if (!entries || entries.length === 0) return
    for (const entry of [...entries]) {
      // A fibra pode ter sido desligada por um listener anterior.
      if (!entries.includes(entry)) continue
      if (entry.once) entry.remove()
      try {
        entry.listener(...args)
      } catch (error) {
        this.reportError(error)
      }
    }
  }
}

/** Cria a raiz de uma aplicação. */
export function createApp(name = 'root'): Context {
  return new Context({ name })
}
