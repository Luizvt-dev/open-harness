// ---------------------------------------------------------------------------
// Núcleo dos slots: um registo de extensões nomeadas, sem React.
//
// O shell declara os slots (`sidebar`, `chat.messages`, `chat.composer`, …) e
// os plugins inscrevem os seus componentes neles. Este módulo não conhece
// React — só guarda componentes e notifica quem observa. Os bindings React
// ficam em `./react.js`.
//
// O contrato é o mesmo do dockkit do original: um plugin não tem de ser
// importado pelo shell; chega a inscrever-se, e o shell desenha o slot.
// ---------------------------------------------------------------------------

/** Um componente de UI plugável. O tipo é opaco ao registo. */
export type SlotComponent = unknown

/** Inscrição de um componente num slot. */
export interface SlotEntry {
  /** Identificador único dentro do slot (o plugin pode re-inscrever). */
  id: string
  /** Componente a renderizar quando o slot desenha. */
  component: SlotComponent
  /** Ordem dentro do slot (menor primeiro). Default `100`. */
  order: number
  /** Metadados livres que o shell pode usar (título, ícone, …). */
  meta?: Record<string, unknown>
}

/** Opções de uma inscrição. */
export interface RegisterOptions {
  /** Identificador; por omissão usa-se o nome do componente. */
  id?: string
  /** Ordem dentro do slot. Default `100`. */
  order?: number
  /** Metadados livres. */
  meta?: Record<string, unknown>
}

/** Observador de mudanças num slot (ou em todos, com `slot = undefined`). */
export type SlotListener = (slot: string | undefined) => void

/** Nome de um slot declarado. */
export type SlotName = string

/**
 * Registo de slots.
 *
 * Uma instância por documento (o shell cria uma e injecta-a no contexto). Os
 * plugins inscrevem-se e recebem de volta uma função de anulação — o React
 * usa-a no `useEffect` para limpar ao desmontar.
 */
export class SlotRegistry {
  private readonly entries = new Map<SlotName, SlotEntry[]>()
  private readonly listeners = new Set<SlotListener>()

  /** Slots com pelo menos uma inscrição, pela ordem alfabética. */
  slots(): SlotName[] {
    return [...this.entries.keys()].sort()
  }

  /** Inscrições de um slot, ordenadas (por `order`, depois `id`). */
  list(slot: SlotName): SlotEntry[] {
    return [...(this.entries.get(slot) ?? [])].sort(
      (a, b) => a.order - b.order || a.id.localeCompare(b.id),
    )
  }

  /**
   * Inscreve um componente num slot.
   *
   * Devolve a função que anula a inscrição. Inscrever o mesmo `id` duas vezes
   * substitui a entrada — é assim que um plugin se re-carrega em HMR sem
   * duplicar componentes.
   */
  register(slot: SlotName, component: SlotComponent, options: RegisterOptions = {}): () => void {
    const id = options.id ?? nameOf(component)
    const entry: SlotEntry = {
      id,
      component,
      order: options.order ?? 100,
      ...(options.meta ? { meta: options.meta } : {}),
    }
    const list = this.entries.get(slot) ?? []
    const existing = list.findIndex((item) => item.id === id)
    if (existing >= 0) list[existing] = entry
    else list.push(entry)
    this.entries.set(slot, list)
    this.emit(slot)
    return () => this.unregister(slot, id)
  }

  /** Remove uma inscrição. Devolve `true` se algo foi removido. */
  unregister(slot: SlotName, id: string): boolean {
    const list = this.entries.get(slot)
    if (!list) return false
    const index = list.findIndex((item) => item.id === id)
    if (index < 0) return false
    list.splice(index, 1)
    if (list.length === 0) this.entries.delete(slot)
    this.emit(slot)
    return true
  }

  /** Observa mudanças; devolve a função que deixa de observar. */
  subscribe(listener: SlotListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Vaza todas as inscrições (testes / shutdown). */
  clear(): void {
    this.entries.clear()
    this.emit(undefined)
  }

  private emit(slot: SlotName | undefined): void {
    for (const listener of [...this.listeners]) listener(slot)
  }
}

/** Nome legível de um componente, para o id por omissão. */
function nameOf(component: SlotComponent): string {
  const name = (component as { displayName?: string; name?: string } | null)?.displayName
    ?? (component as { name?: string } | null)?.name
  return name || 'slot-component'
}
