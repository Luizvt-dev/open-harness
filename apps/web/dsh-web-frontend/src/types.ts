// ---------------------------------------------------------------------------
// Contrato do fio, visto pelo shell.
//
// Estes tipos são o que o host envia por `session.list`, `session.history` e
// `job.run`. Mantêm-se locais ao shell de propósito: são a projecção seriali-
// zável do protocolo para a UI, e o shell não deve arrastar para o browser a
// porta do agente (`dsh-api-remotes`), que é código de Node.
// ---------------------------------------------------------------------------

/**
 * Estado da ligação ao host.
 *
 * Re-exportado do `dsh-client-connection` de propósito: é o MESMO vocabulário
 * — o dot da sidebar reflecte o `state` real do cliente, e um valor local
 * duplicado só podia divergir dele.
 */
export type { ConnectionState } from '@open-harness/dsh-client-connection'

/** Um evento do turno, tal como chega no stream de `job.run`. */
export type AgentEvent =
  | { type: 'turn_start' }
  | { type: 'step_start'; step: number }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use_start'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_end'; id: string; name: string; ok: boolean; output: string; durationMs: number }
  | { type: 'step_end'; step: number; stopReason: string; inputTokens: number; outputTokens: number }
  | { type: 'turn_end'; text: string; steps: number; stoppedByLimit: boolean }
  | { type: 'error'; code: string; message: string }

/** Uma entrada da conversa persistida, pronta a mostrar. */
export type HistoryEntry =
  | { kind: 'user'; text: string; at: number }
  | { kind: 'assistant'; text: string; at: number }
  | { kind: 'tool'; id: string; name: string; at: number; ok?: boolean; output?: string }

/** Uma sessão tal como o host a lista. */
export interface SessionInfo {
  id: string
  cwd: string
  model: string
  modelRef: string
  title: string
  createdAt: number
  running: boolean
}

/** Informação do workspace (rodapé: versão e plataforma). */
export interface WorkspaceInfo {
  version: string
  platform: string
}
