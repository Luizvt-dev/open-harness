// ---------------------------------------------------------------------------
// Bindings React dos slots.
//
// O `SlotRegistry` é framework-agnóstico; aqui liga-se ao React via contexto.
// O shell cria a instância (`SlotProvider`) e desenha `<Slot name="…"/>`; os
// plugins usam `useRegisterSlot` no seu módulo de entrada.
//
// As subscrições usam `useSyncExternalStore`, que é a API certa para estado
// externo ao React — evita o tearing quando vários plugins mutam slots durante
// o render.
// ---------------------------------------------------------------------------

import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import type { RegisterOptions, SlotComponent, SlotEntry, SlotName, SlotRegistry } from './registry.js'

/** Contexto com o registo do documento. */
const SlotContext = createContext<SlotRegistry | null>(null)

/** Provê o registo aos descendentes. */
export function SlotProvider(props: { registry: SlotRegistry; children?: ReactNode }): ReactNode {
  return createElement(SlotContext.Provider, { value: props.registry }, props.children)
}

/** O registo do contexto; lança se o shell esqueceu o provider. */
export function useSlotRegistry(): SlotRegistry {
  const registry = useContext(SlotContext)
  if (!registry) throw new Error('useSlotRegistry: falta <SlotProvider> na árvore')
  return registry
}

/**
 * Observa as inscrições de um slot.
 *
 * Devolve uma lista nova só quando o slot muda — o `useSyncExternalStore`
 * compara por identidade, por isso o valor tem de ser estável entre renders.
 */
export function useSlotEntries(slot: SlotName): SlotEntry[] {
  const registry = useSlotRegistry()
  const subscribe = useMemo(() => (onChange: () => void) => registry.subscribe(() => onChange()), [registry])
  const snapshot = useMemo(() => {
    let cached: SlotEntry[] | null = null
    return () => {
      const next = registry.list(slot)
      // Identidade estável: só recomputa quando o conteúdo difere.
      if (!cached || !sameEntries(cached, next)) cached = next
      return cached
    }
  }, [registry, slot])
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

/** Desenha todas as inscrições de um slot, pela ordem do registo. */
export function Slot(props: { name: SlotName; fallback?: ReactNode; [key: string]: unknown }): ReactNode {
  const entries = useSlotEntries(props.name)
  if (entries.length === 0) return props.fallback ?? null
  const { name: _name, fallback: _fallback, ...rest } = props
  return entries.map((entry) =>
    createElement(entry.component as never, { key: entry.id, ...(entry.meta ?? {}), ...rest }),
  )
}

/**
 * Inscreve um componente num slot enquanto o componente está montado.
 *
 * `component` pode mudar entre renders (ex.: um closure novo); a inscrição
 * guarda a última versão sem se re-inscrever, para não disparar notificações
 * a cada render.
 */
export function useRegisterSlot(
  slot: SlotName,
  component: SlotComponent,
  options: RegisterOptions = {},
): void {
  const registry = useSlotRegistry()
  const latest = useRef(component)
  latest.current = component
  // Só a identidade do slot/id importa para a inscrição em si.
  const id = options.id
  const order = options.order
  const meta = options.meta
  useEffect(() => {
    const stable = (props: unknown) => (latest.current as (p: unknown) => unknown)(props)
    return registry.register(slot, stable, {
      ...(id !== undefined ? { id } : {}),
      ...(order !== undefined ? { order } : {}),
      ...(meta ? { meta } : {}),
    })
  }, [registry, slot, id, order, meta])
}

/** Compara duas listas de inscrições por id/ordem/componente. */
function sameEntries(a: SlotEntry[], b: SlotEntry[]): boolean {
  if (a.length !== b.length) return false
  return a.every((entry, index) => {
    const other = b[index]
    return other !== undefined
      && entry.id === other.id
      && entry.order === other.order
      && entry.component === other.component
  })
}
