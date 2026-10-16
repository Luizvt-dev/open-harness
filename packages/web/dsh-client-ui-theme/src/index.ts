// ---------------------------------------------------------------------------
// `dsh-client-ui-theme` — entrada do plugin.
//
// O host descobre este módulo pelo campo `dsh.client` do `package.json`,
// serve-o em `/plugins/ui-theme/index.js` e mete-o no combo do manifesto; o
// shell importa o combo e chama `install` com o registo de slots partilhado.
//
// Este ficheiro é a ÚNICA porta de entrada — não importa nada de `node:*`,
// porque a mesma compilação corre no navegador e em teste em Node.
// ---------------------------------------------------------------------------

import type { SlotRegistry } from '@open-harness/dsh-client-ui-slots'
import { SLOTS } from '@open-harness/dsh-web-frontend'
import { ThemeToggle } from './theme-toggle.js'
import { installTheme } from './theme.js'

/**
 * Instala o plugin no shell.
 *
 * Obrigatório (é o que o loader procura), síncrono, e seguro de correr mais
 * do que uma vez: o `<style>` é idempotente e a inscrição substitui a entrada
 * com o mesmo id.
 */
export function install(registry: SlotRegistry): void {
  installTheme()
  registry.register(SLOTS.sidebarAfter, ThemeToggle, { id: 'theme-toggle', order: 10 })
}

export { ThemeToggle, nextTheme } from './theme-toggle.js'
export {
  THEME_CSS,
  THEME_STYLE_ID,
  THEME_STORAGE_KEY,
  applyTheme,
  injectStyle,
  installTheme,
  readTheme,
  writeTheme,
} from './theme.js'
export type { Theme } from './theme.js'
