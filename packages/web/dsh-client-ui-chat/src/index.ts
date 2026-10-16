// ---------------------------------------------------------------------------
// `dsh-client-ui-chat` — entrada do plugin.
//
// O host descobre este módulo pelo campo `dsh.client` do `package.json`,
// serve-o em `/plugins/ui-chat/index.js` e mete-o no combo do manifesto; o
// shell importa o combo e chama `install` com o registo de slots partilhado.
//
// Este ficheiro é a ÚNICA porta de entrada — não importa nada de `node:*`,
// porque a mesma compilação corre no navegador e em teste em Node.
// ---------------------------------------------------------------------------

import type { SlotRegistry } from '@open-harness/dsh-client-ui-slots'
import { itemSlot } from '@open-harness/dsh-web-frontend'
import { ChatItem } from './chat-item.js'

/**
 * Slots deste plugin (`chat.item.user` e `chat.item.error`), derivados do
 * shell em vez de escritos à mão — se o shell renomear um slot, o
 * `dsh.client` e o `install` continuam de acordo (há teste para a equivalência).
 */
export const USER_SLOT = itemSlot({ kind: 'user', text: '' })
export const ERROR_SLOT = itemSlot({ kind: 'error', text: '' })

/**
 * Instala o plugin no shell.
 *
 * Obrigatório (é o que o loader procura), síncrono, e seguro de correr mais
 * do que uma vez: re-registar o mesmo id substitui a entrada anterior.
 */
export function install(registry: SlotRegistry): void {
  registry.register(USER_SLOT, ChatItem, { id: 'chat-item', order: 100 })
  registry.register(ERROR_SLOT, ChatItem, { id: 'chat-item', order: 100 })
}

export { ChatItem } from './chat-item.js'
