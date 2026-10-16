// ---------------------------------------------------------------------------
// Tipos partilhados entre a metade Node e a metade navegador.
//
// Este módulo não importa `node:*` de propósito: é carregado dos dois lados,
// tal como `dsh-api-gateway/types`. Tudo o que precise de disco fica nos
// módulos vizinhos (`scan`, `serve`).
// ---------------------------------------------------------------------------

/** Um plugin de UI com entrada no navegador (`dsh.client` no `package.json`). */
export interface ClientPlugin {
  /** Identificador curto (`ui-chat`), único no boot. */
  id: string
  /** Nome npm do pacote que declara o plugin. */
  packageName: string
  /** URL servida da entrada ES (`/plugins/<id>/client.js`). */
  entry: string
  /** Slots que o plugin pretende preencher, pela ordem declarada. */
  slots: string[]
  /** Ordem de carregamento (menor primeiro); `0` quando omitida. */
  order: number
}

/** Módulo de plataforma partilhado (React/Cordis/base) ou dependência do workspace. */
export type PlatformModules = Record<string, string>

/**
 * Manifesto que o host monta em `window.__DSH_BOOT__`.
 *
 * É o contrato único entre o servidor e o navegador: o loader não precisa de
 * saber como o host descobriu os plugins — lê este objecto e importa URLs.
 */
export interface BootManifest {
  /** Versão do formato (hoje sempre `1`). */
  version: 1
  /** Plugins pela ordem de carregamento. */
  plugins: ClientPlugin[]
  /** Tabela de módulos partilhados: import specifier → URL servida. */
  platform: PlatformModules
  /** Combos gerados (`/plugins/__combo__/…`), um por agrupamento útil. */
  combos: ComboManifest[]
}

/** Um combo: um só `import()` que puxa vários plugins pela ordem certa. */
export interface ComboManifest {
  /** Nome do combo (`default`, `all`, …). */
  name: string
  /** URL do módulo combo. */
  url: string
  /** Plugins, pela ordem de carregamento. */
  plugins: string[]
}
