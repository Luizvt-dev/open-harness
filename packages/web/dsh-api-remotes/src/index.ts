import type { RemoteSpec } from '@open-harness/dsh-api-gateway'
import { jobRemote, sessionRemote } from './session.js'
import { accountRemote, terminalRemote } from './stubs.js'
import { settingsRemote, workspaceFilesRemote, workspaceRemote } from './workspace.js'
import type { RemotesOptions } from './types.js'

// Público do dsh-api-remotes: os controllers que o host expõe pelo gateway —
// sessão, jobs (turnos em stream), workspace, ficheiros e definições.
export * from './types.js'
export * from './queue.js'
export * from './session.js'
export * from './workspace.js'
export * from './stubs.js'

/**
 * Cria todos os remotes do host.
 *
 * `terminal` e `account` vêm como stubs explícitos: o plano prevê ambos os
 * controllers, e dizer "ainda não, e porquê" é melhor do que não servir o
 * método (que o cliente leria como `method_not_found`).
 */
export function createRemotes(options: RemotesOptions): RemoteSpec[] {
  return [
    sessionRemote(options.host),
    jobRemote(options.host),
    workspaceRemote(options),
    workspaceFilesRemote(options),
    settingsRemote({ read: options.readSettings ?? (() => ({})) }),
    terminalRemote(),
    accountRemote(),
  ]
}
