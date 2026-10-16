// ---------------------------------------------------------------------------
// Tokens e comutador de tema.
//
// O `style.css` do shell é escuro por omissão (é aí que os tokens vivem); este
// plugin acrescenta o claro por cima, identificando-o pelo atributo
// `data-theme` no `<html>`. Assim o shell não precisa de saber que existe um
// segundo tema — se o plugin não carregar, a UI fica exactamente como estava.
//
// As regras `.msg--error` e `.button--primary` vêm do shell com cores fixas
// (pensadas para o escuro): em claro são as únicas duas que têm de ser
// corrigidas, daí estarem aqui e não num fork do ficheiro.
// ---------------------------------------------------------------------------

/** Tema suportado por este plugin. */
export type Theme = 'dark' | 'light'

/** Id do `<style>` injectado — também serve de guarda contra duplicados. */
export const THEME_STYLE_ID = 'dsh-ui-theme'

/** Chave de `localStorage` com o tema escolhido. */
export const THEME_STORAGE_KEY = 'dsh-theme'

/** Regras do tema claro e do comutador. */
export const THEME_CSS = `:root {
  color-scheme: dark;
}

:root[data-theme='light'] {
  color-scheme: light;
  --bg: #f4f6fa;
  --bg-soft: #ffffff;
  --bg-raised: #ffffff;
  --line: #d9dfe9;
  --text: #17202e;
  --text-dim: #59657a;
  --accent: #1f6feb;
  --ok: #177245;
  --fail: #b42318;
  --warn: #8a6100;
}

/* Duas cores fixas do shell, pensadas para o fundo escuro. */
:root[data-theme='light'] .msg--error {
  background: #fdecec;
}

:root[data-theme='light'] .button--primary {
  color: #ffffff;
}

.ui-theme {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  margin: 0 0 8px;
  padding: 7px 12px;
  background: var(--bg-raised);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  color: var(--text-dim);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.ui-theme:hover {
  color: var(--text);
  border-color: var(--accent);
}

.ui-theme-value {
  color: var(--accent);
  font-weight: 600;
}
`

/**
 * Injecta um `<style>` no `<head>`, uma vez só.
 *
 * Corre no `install` do plugin (o shell chama-o depois de montar), por isso em
 * Node/SSR não há documento e aqui não acontece nada — é o que torna o teste de
 * `install` livre de browser.
 */
export function injectStyle(id: string, css: string): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(id)) return
  const style = document.createElement('style')
  style.id = id
  style.textContent = css
  document.head.appendChild(style)
}

/**
 * Storage onde o tema persiste.
 *
 * Condicionado ao `document` de propósito: `localStorage` é API de browser, e
 * em Node 24 existe um global homónimo (experimental) cujo acesso imprime um
 * aviso a cada processo — sem documento não há nada a persistir.
 */
function themeStorage(): Storage | undefined {
  if (typeof document === 'undefined') return undefined
  try {
    return localStorage
  } catch {
    // Contexto restrito (ex.: storage desactivado): segue sem persistir.
    return undefined
  }
}

/**
 * Lê o tema guardado; sem storage, fica o escuro.
 *
 * `storage` é opcional só para teste (o default é o storage real do
 * documento) — assim o teste não tem de trocar um global em tempo de execução.
 */
export function readTheme(storage: Storage | null | undefined = themeStorage()): Theme {
  try {
    if (storage?.getItem(THEME_STORAGE_KEY) === 'light') return 'light'
  } catch {
    // Storage bloqueado: escolher o default é melhor que rebentar.
  }
  return 'dark'
}

/** Grava o tema escolhido, ignorando contextos sem storage. */
export function writeTheme(
  theme: Theme,
  storage: Storage | null | undefined = themeStorage(),
): void {
  try {
    storage?.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // Idem: o tema continua a funcionar nesta sessão, só não persiste.
  }
}

/** Reflecte o tema no `<html>` (é o que os tokens escutam). */
export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return
  document.documentElement.dataset['theme'] = theme
}

/** Prepara o tema no arranque do plugin: CSS no documento + atributo aplicado. */
export function installTheme(): void {
  injectStyle(THEME_STYLE_ID, THEME_CSS)
  applyTheme(readTheme())
}
