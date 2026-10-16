// ---------------------------------------------------------------------------
// Superfície pública do shell.
//
// É o que um `ui-*` importa para saber quais slots existem, que mensagens
// desenha e onde se inscreve. Nada aqui toca em `node:*`: esta entrada corre no
// navegador, resolvida pelo import map (`@open-harness/dsh-web-frontend`).
//
// A entrada Node (`./platform`) fica à parte: resolve os ficheiros do React
// que o host tem de servir, e só faz sentido em processo de servidor.
// ---------------------------------------------------------------------------

export { Shell } from './shell.js'
export type { HostClient, ShellProps } from './shell.js'

export { SLOTS, DEFAULT_ITEM_ID, itemSlot } from './slots.js'

export {
  emptyConversation,
  fromHistory,
  appendUser,
  applyEvent,
  turnStats,
} from './conversation.js'
export type { Conversation, Message } from './conversation.js'

export { ConversationItem, ConversationView, MessageBubble, ToolRow } from './conversation-view.js'
export { Sidebar, connectionLabel } from './sidebar.js'
export { Topbar } from './topbar.js'
export { Composer } from './composer.js'

export { shellRegistry } from './registry.js'
export { installPlugins } from './plugin.js'
export type { UiPlugin } from './plugin.js'

export type { AgentEvent, HistoryEntry, SessionInfo, WorkspaceInfo, ConnectionState } from './types.js'
