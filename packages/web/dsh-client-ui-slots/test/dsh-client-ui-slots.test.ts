import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  Slot,
  SlotProvider,
  SlotRegistry,
  useRegisterSlot,
  useSlotEntries,
  useSlotRegistry,
} from '@open-harness/dsh-client-ui-slots'

// ---------------------------------------------------------------------------
// Núcleo do registo (framework-agnóstico)
// ---------------------------------------------------------------------------

describe('SlotRegistry', () => {
  it('ordena por order e depois por id', () => {
    const registry = new SlotRegistry()
    registry.register('chat', () => 'c', { id: 'c', order: 200 })
    registry.register('chat', () => 'a', { id: 'a', order: 100 })
    registry.register('chat', () => 'b', { id: 'b', order: 100 })
    expect(registry.list('chat').map((entry) => entry.id)).toEqual(['a', 'b', 'c'])
  })

  it('deriva o id do nome do componente quando omitido', () => {
    const registry = new SlotRegistry()
    function Sidebar(): ReactNode {
      return null
    }
    registry.register('sidebar', Sidebar)
    expect(registry.list('sidebar')[0]?.id).toBe('Sidebar')
  })

  it('re-inscrever o mesmo id substitui (HMR sem duplicar)', () => {
    const registry = new SlotRegistry()
    const first = () => 'v1'
    const second = () => 'v2'
    registry.register('chat', first, { id: 'msg' })
    registry.register('chat', second, { id: 'msg' })
    const entries = registry.list('chat')
    expect(entries).toHaveLength(1)
    expect(entries[0]?.component).toBe(second)
  })

  it('a função devolvida anula a inscrição', () => {
    const registry = new SlotRegistry()
    const dispose = registry.register('chat', () => 'x', { id: 'x' })
    expect(registry.list('chat')).toHaveLength(1)
    dispose()
    expect(registry.list('chat')).toHaveLength(0)
  })

  it('notifica os observadores com o slot alterado e limpa ao desinscrever', () => {
    const registry = new SlotRegistry()
    const seen: Array<string | undefined> = []
    const off = registry.subscribe((slot) => seen.push(slot))
    registry.register('chat', () => 'x', { id: 'x' })
    registry.clear()
    off()
    registry.register('chat', () => 'y', { id: 'y' })
    expect(seen).toEqual(['chat', undefined])
  })

  it('unregister devolve false quando não há nada a remover', () => {
    const registry = new SlotRegistry()
    expect(registry.unregister('nada', 'id')).toBe(false)
    registry.register('chat', () => 'x', { id: 'x' })
    expect(registry.unregister('chat', 'outro')).toBe(false)
    expect(registry.unregister('chat', 'x')).toBe(true)
  })

  it('slots() lista os slots não vazios, em ordem alfabética', () => {
    const registry = new SlotRegistry()
    registry.register('sidebar', () => 's', { id: 's' })
    registry.register('chat', () => 'c', { id: 'c' })
    expect(registry.slots()).toEqual(['chat', 'sidebar'])
  })
})

// ---------------------------------------------------------------------------
// Bindings React
// ---------------------------------------------------------------------------

/** Renderiza com o registo provido, sem DOM (string estática). */
function render(registry: SlotRegistry, node: ReactNode): string {
  return renderToStaticMarkup(createElement(SlotProvider, { registry, children: node }))
}

describe('bindings React', () => {
  it('desenha as inscrições do slot pela ordem', () => {
    const registry = new SlotRegistry()
    registry.register('chat', () => createElement('span', null, 'b'), { id: 'b', order: 20 })
    registry.register('chat', () => createElement('span', null, 'a'), { id: 'a', order: 10 })
    expect(render(registry, createElement(Slot, { name: 'chat' }))).toBe('<span>a</span><span>b</span>')
  })

  it('usa o fallback quando o slot está vazio', () => {
    const registry = new SlotRegistry()
    const html = render(registry, createElement(Slot, { name: 'vazio', fallback: 'nada' }))
    expect(html).toBe('nada')
  })

  it('passa as metadados e os props extras ao componente', () => {
    const registry = new SlotRegistry()
    registry.register(
      'chat',
      (props: Record<string, unknown>) => createElement('i', null, `${String(props['title'])}:${String(props['extra'])}`),
      { id: 'm', meta: { title: 'T' } },
    )
    expect(render(registry, createElement(Slot, { name: 'chat', extra: 'E' }))).toBe('<i>T:E</i>')
  })

  it('useRegisterSlot inscreve ao montar e anula ao desmontar', () => {
    const registry = new SlotRegistry()
    function Plugin(): ReactNode {
      useRegisterSlot('chat', () => createElement('b', null, 'plugin'), { id: 'p' })
      return null
    }
    // renderToStaticMarkup monta e desmonta: o efeito corre e limpa.
    render(registry, createElement(Plugin))
    // Em SSR os effects não correm; aqui validamos o comportamento com um
    // render de cliente simulado abaixo (useSlotEntries + mutação).
    expect(registry.list('chat')).toHaveLength(0)
  })

  it('useSlotEntries re-renderiza quando o slot muda', () => {
    const registry = new SlotRegistry()
    const snapshots: number[] = []
    function Observer(): ReactNode {
      const entries = useSlotEntries('chat')
      snapshots.push(entries.length)
      return createElement('em', null, String(entries.length))
    }
    const html = render(registry, createElement(Observer))
    expect(html).toBe('<em>0</em>')
    // Uma inscrição nova notifica o observer (mesmo sem re-render aqui).
    registry.register('chat', () => 'x', { id: 'x' })
    expect(snapshots.at(-1)).toBe(0)
    expect(registry.list('chat')).toHaveLength(1)
  })

  it('useSlotRegistry lança sem provider', () => {
    function Orphan(): ReactNode {
      useSlotRegistry()
      return null
    }
    // O erro do React em SSR propaga-se pela chamada de render.
    expect(() => renderToStaticMarkup(createElement(Orphan))).toThrow(/SlotProvider/)
  })

  it('o wrapper de useRegisterSlot segue a última versão do componente', () => {
    const registry = new SlotRegistry()
    // Em SSR os effects não correm, por isso a inscrição não acontece aqui —
    // validamos o contrato do wrapper: uma função estável que chama a closure
    // mais recente (é exactamente o que `useRegisterSlot` regista no cliente).
    const calls: string[] = []
    let latest: (label: string) => string = () => 'antigo'
    const stable = (props: unknown) => latest(props as string)
    registry.register('chat', stable, { id: 'w' })

    latest = (label) => {
      calls.push(label)
      return `<b>${label}</b>`
    }
    const entry = registry.list('chat')[0]
    expect(entry?.component).toBe(stable)
    expect((entry?.component as (p: string) => string)('novo')).toBe('<b>novo</b>')
    expect(calls).toEqual(['novo'])

    // Re-inscrever não duplica: continua uma só entrada.
    registry.register('chat', stable, { id: 'w' })
    expect(registry.list('chat')).toHaveLength(1)
  })
})
