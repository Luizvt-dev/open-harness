import type { Disposer } from '@open-harness/cosmokit'
import type { Context } from './context.js'
import { DisposedError } from './errors.js'

let nextFiberId = 1

interface FiberEntry {
  run: Disposer
  done: boolean
}

/**
 * Fibra = unidade de posse dos efeitos (`ctx.effect`), com dispose idempotente.
 * Cada `Context` tem exatamente uma fibra; a árvore de fibras acompanha a árvore
 * de contextos (contexto pai → fibra pai).
 *
 * Ordem de dispose: evento `dispose` → filhos (LIFO de criação) → efeitos próprios (LIFO).
 */
export class Fiber {
  readonly id = nextFiberId++
  readonly context: Context
  readonly parent: Fiber | null
  private entries: FiberEntry[] = []
  private _disposed = false

  constructor(context: Context, parent: Fiber | null = null) {
    this.context = context
    this.parent = parent
  }

  get disposed(): boolean {
    return this._disposed
  }

  /** Registra um efeito; devolve um disposer idempotente que também o remove da lista. */
  add(disposer: Disposer): Disposer {
    if (this._disposed) throw new DisposedError(this.context.path)
    const entry: FiberEntry = { run: disposer, done: false }
    this.entries.push(entry)
    return async () => {
      if (entry.done) return
      entry.done = true
      const index = this.entries.indexOf(entry)
      if (index >= 0) this.entries.splice(index, 1)
      await entry.run()
    }
  }

  async dispose(): Promise<void> {
    if (this._disposed) return
    this._disposed = true
    const ctx = this.context
    ctx.status = 'disposed'
    // 1. notifica a própria fibra (listeners ainda executam; novos efeitos já lançam)
    ctx.notifyDispose()
    // 2. filhos: LIFO de criação (dependentes tipicamente criados depois)
    for (const child of [...ctx.children].reverse()) await child.fiber.dispose()
    // 3. efeitos próprios: LIFO
    const pending = this.entries.splice(0, this.entries.length).reverse()
    for (const entry of pending) {
      if (entry.done) continue
      entry.done = true
      try {
        await entry.run()
      } catch (error) {
        ctx.reportError(error)
      }
    }
    // 4. desanexa da árvore (emissões seguintes do pai não entram aqui)
    const parent = ctx.parent
    if (parent) {
      const index = parent.children.indexOf(ctx)
      if (index >= 0) parent.children.splice(index, 1)
    }
  }
}
