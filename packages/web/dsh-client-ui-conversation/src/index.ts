// ---------------------------------------------------------------------------
// `dsh-client-ui-conversation` — entrada do plugin.
//
// O host descobre este módulo pelo campo `dsh.client` do `package.json`,
// serve-o em `/plugins/ui-conversation/index.js` e mete-o no combo do
// manifesto; o shell importa o combo e chama `install` com o registo de
// slots partilhado.
//
// Este ficheiro é a ÚNICA porta de entrada — não importa nada de `node:*`,
// porque a mesma compilação corre no navegador e em teste em Node.
// ---------------------------------------------------------------------------

import type { SlotRegistry } from '@open-harness/dsh-client-ui-slots'
import { itemSlot } from '@open-harness/dsh-web-frontend'
import { AssistantItem } from './assistant.js'

/**
 * Slot deste plugin (`chat.item.assistant`), derivado do shell em vez de
 * escrito à mão — se o shell renomear o slot, o `dsh.client` e o `install`
 * continuam de acordo (há teste para a equivalência).
 */
export const ASSISTANT_SLOT = itemSlot({ kind: 'assistant', text: '' })

/**
 * Instala o plugin no shell.
 *
 * Obrigatório (é o que o loader procura), síncrono, e seguro de correr mais
 * do que uma vez: re-registar o mesmo id substitui a entrada anterior.
 */
export function install(registry: SlotRegistry): void {
  registry.register(ASSISTANT_SLOT, AssistantItem, { id: 'assistant', order: 100 })
}

export { AssistantItem } from './assistant.js'
