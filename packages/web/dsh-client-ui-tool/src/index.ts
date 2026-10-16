// ---------------------------------------------------------------------------
// `dsh-client-ui-tool` — entrada do plugin.
//
// O host descobre este módulo pelo campo `dsh.client` do `package.json`,
// serve-o em `/plugins/ui-tool/index.js` e mete-o no combo do manifesto; o
// shell importa o combo e chama `install` com o registo de slots partilhado.
//
// Este ficheiro é a ÚNICA porta de entrada — não importa nada de `node:*`,
// porque a mesma compilação corre no navegador e em teste em Node.
// ---------------------------------------------------------------------------

import type { SlotRegistry } from '@open-harness/dsh-client-ui-slots'
import { itemSlot } from '@open-harness/dsh-web-frontend'
import { ToolRowItem } from './tool-row.js'

/**
 * Slot deste plugin (`chat.item.tool`), derivado do shell em vez de escrito
 * à mão — se o shell renomear o slot, o `dsh.client` e o `install` continuam
 * de acordo (há teste para a equivalência).
 */
export const TOOL_SLOT = itemSlot({ kind: 'tool', id: '', name: '' })

/**
 * Instala o plugin no shell.
 *
 * Obrigatório (é o que o loader procura), síncrono, e seguro de correr mais
 * do que uma vez: re-registar o mesmo id substitui a entrada anterior.
 */
export function install(registry: SlotRegistry): void {
  registry.register(TOOL_SLOT, ToolRowItem, { id: 'tool-row', order: 100 })
}

export { ToolRowItem } from './tool-row.js'
