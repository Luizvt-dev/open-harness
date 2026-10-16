// ---------------------------------------------------------------------------
// Testes do plugin `ui-theme`.
//
// Tudo em Node de propósito: um plugin que só funciona com browser não serve
// para nada num host que também corre em servidor. Os testes com
// `document`/`localStorage` falsos são os que provam a injeção de CSS e a
// persistência sem pedir um DOM real.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@open-harness/dsh-client-ui-slots'
import { SLOTS } from '@open-harness/dsh-web-frontend'
import {
  THEME_CSS,
  THEME_STYLE_ID,
  ThemeToggle,
  injectStyle,
  install,
  installTheme,
  nextTheme,
  readTheme,
  writeTheme,
} from '@open-harness/dsh-client-ui-theme'

/** Documento falso mínimo: só o que `injectStyle`, `applyTheme` e o install tocam. */
function fakeDocument(root: { dataset: Record<string, string> }) {
  const children: Array<{ id: string; textContent: string }> = []
  const doc = {
    children,
    documentElement: root,
    getElementById: (id: string) => children.find((node) => node.id === id) ?? null,
    createElement: () => ({ id: '', textContent: '' }),
    head: {
      appendChild: (node: { id: string; textContent: string }) => {
        children.push(node)
        return node
      },
    },
  } as unknown as Document
  return { doc, children }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('campo dsh.client do package.json', () => {
  it('declara entrada, slots e ordem', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      dsh?: { client?: { entry?: string; slots?: string[]; order?: number } }
    }
    const client = pkg.dsh?.client
    expect(client?.entry).toBe('./dist/index.js')
    expect(client?.slots).toEqual([SLOTS.sidebarAfter])
    // Antes dos plugins de conteúdo: os tokens têm de existir quando a
    // conversa for desenhada.
    expect(client?.order).toBe(10)
  })
})

describe('install', () => {
  it('inscreve o comutador em sidebar.after sem browser', () => {
    const registry = new SlotRegistry()
    install(registry)

    expect(registry.slots()).toEqual([SLOTS.sidebarAfter])
    const entries = registry.list(SLOTS.sidebarAfter)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.id).toBe('theme-toggle')
    expect(entries[0]?.component).toBe(ThemeToggle)
  })

  it('é idempotente (o HMR volta a chamar o mesmo install)', () => {
    const registry = new SlotRegistry()
    install(registry)
    install(registry)
    expect(registry.list(SLOTS.sidebarAfter)).toHaveLength(1)
  })

  it('sem `document` não injecta CSS nem tenta persistir', () => {
    expect(typeof document).toBe('undefined')
    expect(() => install(new SlotRegistry())).not.toThrow()
    expect(() => writeTheme('light')).not.toThrow()
    expect(readTheme()).toBe('dark')
  })
})

describe('estado do tema', () => {
  it('usa o escuro por omissão e alterna em par', () => {
    expect(readTheme()).toBe('dark')
    expect(nextTheme('dark')).toBe('light')
    expect(nextTheme('light')).toBe('dark')
  })

  it('guarda e lê o tema através do storage recebido', () => {
    const store = new Map<string, string>()
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    } as unknown as Storage

    expect(readTheme(storage)).toBe('dark')
    writeTheme('light', storage)
    expect(store.get('dsh-theme')).toBe('light')
    expect(readTheme(storage)).toBe('light')
  })
})

describe('injector de estilo', () => {
  it('injecta uma vez só e depois reaproveita o mesmo elemento', () => {
    const { doc, children } = fakeDocument({ dataset: {} })
    vi.stubGlobal('document', doc)

    injectStyle('um', 'body {}')
    injectStyle('um', 'body {}')
    injectStyle('dois', 'html {}')

    expect(children.map((node) => node.id)).toEqual(['um', 'dois'])
  })

  it('instala o tema completo com documento falso', () => {
    // Sem isto, `readTheme` apanharia o `localStorage` global do Node (que em
    // Node 24 emite um ExperimentalWarning em vez de funcionar).
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined })
    const root: { dataset: Record<string, string> } = { dataset: {} }
    const { doc, children } = fakeDocument(root)
    vi.stubGlobal('document', doc)

    installTheme()
    expect(children.find((node) => node.id === THEME_STYLE_ID)?.textContent).toBe(THEME_CSS)
    expect(root.dataset['theme']).toBe('dark')
  })
})

describe('css', () => {
  it('define o atributo que o comutador escreve e corrige as cores fixas', () => {
    expect(THEME_CSS).toContain("[data-theme='light']")
    // Cores fixas do shell que ficariam ilegíveis em fundo claro.
    expect(THEME_CSS).toContain('.msg--error')
    expect(THEME_CSS).toContain('.button--primary')
    // Chaves equilibradas: um CSS partido rebenta o resto da folha.
    expect(THEME_CSS.split('{')).toHaveLength(THEME_CSS.split('}').length)
  })
})

describe('ThemeToggle', () => {
  it('renderiza o estado actual sem tocar em browser', () => {
    const html = renderToStaticMarkup(createElement(ThemeToggle))
    expect(html).toContain('class="ui-theme"')
    expect(html).toContain('type="button"')
    expect(html).toContain('escuro')
    expect(html).not.toContain('claro')
  })
})
