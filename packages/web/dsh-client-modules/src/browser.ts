// ---------------------------------------------------------------------------
// Metade navegador: loader lazy dos módulos de UI.
//
// Não importa `node:*` — este módulo é carregado pelo browser via import map
// (`/client/dsh-client-modules/browser.js`). O contrato é o manifesto que o
// host monta em `window.__DSH_BOOT__` (ver `./types.js`).
//
// O loader é "lazy" a sério: nada é importado até `loadPlugin`/`loadAll` serem
// chamados, e cada entrada é importada uma só vez (cache de promessas).
// ---------------------------------------------------------------------------

import type { BootManifest, ClientPlugin } from './types.js'

export type { BootManifest, ClientPlugin, ComboManifest, PlatformModules } from './types.js'

/**
 * Um `head` de documento, mínimo e sem lib DOM.
 *
 * O repositório compila sem `dom` (só `node` + globals comuns); o loader
 * precisa de pouco mais do que `appendChild`, e recebe-o injectado nos
 * testes. No navegador, `defaultHead()` lê o `document` via `globalThis`.
 */
export interface HeadLike {
  appendChild: (node: unknown) => void
}

/** `document.head` quando há DOM; `null` no Node (testes, CLI). */
function defaultHead(): HeadLike | null {
  const doc = (globalThis as { document?: { head?: HeadLike } }).document
  return doc?.head ?? null
}

/**
 * Tabela de módulos de plataforma partilhados.
 *
 * O loader injeta estas entradas no import map do documento ANTES de carregar
 * qualquer plugin, para que `import 'react'` num plugin resolva para a URL
 * servida pelo host — um só React para toda a UI, como no original.
 *
 * As URLs vêm do manifesto (`manifest.platform`); esta tabela só declara os
 * nomes que a plataforma garante, para o shell as poder pré-carregar.
 */
export const PLATFORM_MODULES = ['react', 'react-dom', 'react/jsx-runtime', '@open-harness/cordis'] as const

/** Um módulo de plataforma (nome importável → URL servida). */
export type PlatformEntry = Record<string, string>

/** Erros do loader, com o plugin de origem quando couber. */
export class ClientModuleError extends Error {
  readonly pluginId: string | null

  constructor(message: string, pluginId: string | null = null, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ClientModuleError'
    this.pluginId = pluginId
  }
}

/** Opções do loader. */
export interface ModuleLoaderOptions {
  /** Manifesto; por omissão lê `window.__DSH_BOOT__`. */
  manifest?: BootManifest
  /** Import injectável (testes); por omissão usa `import()` dinâmico. */
  importer?: (url: string) => Promise<unknown>
  /** Alvo onde injectar o import map. Default `document.head` (ou `null` sem DOM). */
  head?: HeadLike | null
}

/** O manifesto lido do global de boot, ou `null` se não existir. */
export function readBootManifest(scope?: { __DSH_BOOT__?: BootManifest }): BootManifest | null {
  const source = scope ?? (globalThis as { __DSH_BOOT__?: BootManifest })
  const manifest = source.__DSH_BOOT__
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.plugins)) return null
  return manifest
}

/**
 * Loader dos módulos de UI.
 *
 * Uma instância por documento: guarda o manifesto, o import map já injectado
 * e o cache de promessas por plugin (importar duas vezes a mesma URL é
 * sempre o mesmo módulo, mas a promessa partilhada evita corridas).
 */
export class ModuleLoader {
  readonly manifest: BootManifest
  private readonly importer: (url: string) => Promise<unknown>
  private readonly head: HeadLike | null
  private readonly cache = new Map<string, Promise<unknown>>()
  private readonly loaded = new Set<string>()
  private mapInstalled = false

  constructor(options: ModuleLoaderOptions = {}) {
    const manifest = options.manifest ?? readBootManifest()
    if (!manifest) {
      throw new ClientModuleError('sem manifesto __DSH_BOOT__ (o host serve /__dsh_boot__.js)')
    }
    this.manifest = manifest
    this.importer = options.importer ?? ((url: string) => import(/* @vite-ignore */ url))
    this.head = options.head !== undefined ? options.head : defaultHead()
  }

  /** Plugin pelo id, ou `undefined`. */
  plugin(id: string): ClientPlugin | undefined {
    return this.manifest.plugins.find((p) => p.id === id)
  }

  /** Plugins pela ordem de carregamento. */
  plugins(): ClientPlugin[] {
    return [...this.manifest.plugins]
  }

  /**
   * Garante que o import map do documento contém os módulos de plataforma.
   *
   * Só injeta uma vez e só quando há `<head>`: o loader também corre em
   * testes sem DOM. Os plugins são importados por URL absoluta, por isso
   * não precisam de entrada no mapa.
   */
  installPlatformMap(): void {
    if (this.mapInstalled || !this.head) return
    const entries = Object.entries(this.manifest.platform)
    if (entries.length === 0) return
    const imports: Record<string, string> = Object.fromEntries(entries)
    const script = {
      tagName: 'script',
      type: 'importmap',
      textContent: JSON.stringify({ imports }),
    }
    this.head.appendChild(script)
    this.mapInstalled = true
  }

  /**
   * Importa um plugin pelo id, uma só vez.
   *
   * O cache é por PROMESSA: se duas partes pedirem o mesmo plugin em
   * paralelo, o `import()` corre uma vez. Um erro não fica guardado — o
   * chamador pode tentar de novo depois de o host repor o ficheiro.
   */
  async loadPlugin(id: string): Promise<unknown> {
    const plugin = this.plugin(id)
    if (!plugin) throw new ClientModuleError(`plugin desconhecido: ${id}`, id)
    const cached = this.cache.get(id)
    if (cached) return cached
    this.installPlatformMap()
    const promise = this.importer(plugin.entry).then(
      (module) => {
        this.loaded.add(id)
        return module
      },
      (cause: unknown) => {
        this.cache.delete(id)
        throw new ClientModuleError(`falhou ao carregar ${id} (${plugin.entry})`, id, { cause })
      },
    )
    this.cache.set(id, promise)
    return promise
  }

  /** Importa todos os plugins pela ordem de carregamento. */
  async loadAll(): Promise<Map<string, unknown>> {
    const modules = new Map<string, unknown>()
    for (const plugin of this.plugins()) {
      modules.set(plugin.id, await this.loadPlugin(plugin.id))
    }
    return modules
  }

  /** Importa o combo do manifesto, se existir — uma ida para todos. */
  async loadCombo(name = 'default'): Promise<Map<string, unknown>> {
    const combo = this.manifest.combos.find((c) => c.name === name)
    if (!combo) return this.loadAll()
    this.installPlatformMap()
    await this.importer(combo.url)
    const modules = new Map<string, unknown>()
    for (const id of combo.plugins) {
      const plugin = this.plugin(id)
      if (plugin) modules.set(id, await this.loadPlugin(id))
    }
    return modules
  }

  /** Ids já importados com sucesso. */
  loadedPlugins(): string[] {
    return [...this.loaded]
  }
}

/**
 * Cria um loader a partir do manifesto global.
 *
 * Atalho para o shell: `const loader = createLoader()`.
 */
export function createLoader(options: ModuleLoaderOptions = {}): ModuleLoader {
  return new ModuleLoader(options)
}
