import { watch, type FSWatcher } from 'node:fs'
import { Deferred, noop } from '@open-harness/cosmokit'

export type ReloadReason = 'manual' | 'watch' | 'initial'

export interface ReloadTrigger {
  /** Ficheiro que motivou o reload (quando conhecido). */
  file?: string
  reason: ReloadReason
}

export interface HmrOptions<T> {
  /** Ficheiros a observar (ex.: `cordis.patch.yml` do perfil, `package.json`). */
  files?: string[]
  /** Executa um reload com os triggers agregados. Nunca corre em paralelo. */
  reload: (triggers: ReloadTrigger[]) => Promise<T> | T
  /** Janela de debounce dos eventos do watcher. Default 40 ms. */
  debounce?: number
  /** Sem ficheiros, sem watcher — só `invalidate()`. */
  watch?: boolean
  onReload?: (result: T, triggers: ReloadTrigger[]) => void
  onError?: (error: unknown, triggers: ReloadTrigger[]) => void
}

interface Queued<T> {
  trigger: ReloadTrigger
  deferred: Deferred<T>
}

/**
 * Reload serializado: um reload de cada vez, com agregação (coalescing) dos
 * triggers que chegarem enquanto o actual corre. É o que permite trocar
 * `cordis.patch.yml` sem reiniciar o processo — ver critério de aceite da Fase 1.
 */
export class Hmr<T = unknown> {
  private readonly options: HmrOptions<T>
  private readonly queue: Queued<T>[] = []
  private readonly watchers: FSWatcher[] = []
  private active = false
  private debounceTimer: NodeJS.Timeout | undefined

  constructor(options: HmrOptions<T>) {
    this.options = options
  }

  get running(): boolean {
    return this.active
  }

  get watching(): boolean {
    return this.watchers.length > 0
  }

  /** Começa a observar `options.files`. Falhas por ficheiro ausente são ignoradas. */
  start(): void {
    if (this.watchers.length > 0) return
    for (const file of this.options.files ?? []) {
      try {
        const watcher = watch(file, { persistent: false }, () => {
          this.scheduleWatch({ file, reason: 'watch' })
        })
        watcher.on('error', noop)
        this.watchers.push(watcher)
      } catch {
        // ficheiro ainda não existe — observável na próxima arranque
      }
    }
  }

  /** Fecha watchers e cancela debounce pendente. Reloads em curso completam. */
  stop(): void {
    for (const watcher of this.watchers.splice(0, this.watchers.length)) {
      try {
        watcher.close()
      } catch {
        /* já fechado */
      }
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = undefined
    }
  }

  /**
   * Enfileira um reload. Resolve com o resultado do reload que consumir este
   * trigger (os triggers que chegam durante um reload correm todos juntos no
   * seguinte). Rejeita se o `reload` rejeitar.
   */
  invalidate(trigger: Partial<ReloadTrigger> = {}): Promise<T> {
    const deferred = new Deferred<T>()
    this.queue.push({ trigger: { reason: 'manual', ...trigger }, deferred })
    this.kick()
    return deferred.promise
  }

  private scheduleWatch(trigger: ReloadTrigger): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined
      void this.invalidate(trigger)
    }, this.options.debounce ?? 40)
  }

  private kick(): void {
    if (this.active || this.queue.length === 0) return
    const batch = this.queue.splice(0, this.queue.length)
    const triggers = batch.map((entry) => entry.trigger)
    this.active = true
    void Promise.resolve()
      .then(() => this.options.reload(triggers))
      .then(
        (result) => {
          for (const entry of batch) entry.deferred.resolve(result)
          this.options.onReload?.(result, triggers)
        },
        (error: unknown) => {
          for (const entry of batch) entry.deferred.reject(error)
          this.options.onError?.(error, triggers)
        },
      )
      .finally(() => {
        this.active = false
        this.kick()
      })
  }
}
