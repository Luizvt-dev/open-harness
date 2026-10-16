// ---------------------------------------------------------------------------
// Slots declarados pelo shell.
//
// O shell desenha os slots e os plugins `ui-*` inscrevem-se neles (ver
// `dsh-client-ui-slots`). Há duas famílias, com semânticas diferentes:
//
// - *aditivos* (`sidebar.before`, `composer.after`, …): o conteúdo do shell
//   continua a desenhar-se, e o que os plugins inscrevem aparece antes ou
//   depois. Um plugin que queira só um botão extra usa um destes;
//
// - *por tipo de item* (`chat.item.user`, `chat.item.tool`, …): se um slot
//   tiver inscrições, o shell NÃO desenha a sua versão por omissão — é assim
//   que o `ui-tool` toma conta das linhas de tool sem o shell o conhecer.
//   Como os slots são derivados do `kind` da mensagem, um plugin que só
//   saiba de tools regista só em `chat.item.tool` e as mensagens normais
//   continuam com o renderizador embutido.
//
// A ordem relativa às inscrições importa: o shell monta primeiro (o bootstrap
// carrega os plugins depois de renderizar), por isso uma inscrição nova num
// slot por item substitui a versão por omissão — desde que o plugin use o
// mesmo `id` (`default`).
// ---------------------------------------------------------------------------

import type { Message } from './conversation.js'

/** Slots aditivos: o shell desenha sempre, os plugins acrescentam. */
export const SLOTS = {
  /** Antes do cabeçalho da sidebar. */
  sidebarBefore: 'sidebar.before',
  /** Depois da lista de sessões, antes do rodapé. */
  sidebarAfter: 'sidebar.after',
  /** Antes do conteúdo do topbar. */
  topbarBefore: 'topbar.before',
  /** Depois do conteúdo do topbar. */
  topbarAfter: 'topbar.after',
  /** Por baixo da conversa (acções rápidas, sugestões). */
  messagesAfter: 'messages.after',
  /** Antes da linha de acções do composer. */
  composerBefore: 'composer.before',
  /** Depois da linha de acções do composer. */
  composerAfter: 'composer.after',
} as const

/** `id` da inscrição por omissão de um slot de item. */
export const DEFAULT_ITEM_ID = 'default'

/** Nome do slot de renderização para um tipo de mensagem. */
export function itemSlot(message: Message): string {
  return `chat.item.${message.kind}`
}
