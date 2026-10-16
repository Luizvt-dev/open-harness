// ---------------------------------------------------------------------------
// Porta do agente e vocabulário do fio
//
// Os controllers remotos não sabem nada do `AgentService`, do loop nem dos
// provedores: falam com esta porta. É o que permite testar o transporte com um
// agente falso e trocar a implementação por trás sem tocar no protocolo.
// ---------------------------------------------------------------------------

/**
 * Evento do agente no fio.
 *
 * É o que o browser vê chegar durante um turno. Mantém-se como contrato do
 * transporte — se o loop mudar o seu vocabulário interno, a alteração faz-se
 * numa linha na camada que compõe o host, e o cliente não muda.
 */
export type AgentEvent =
  | { type: 'turn_start' }
  | { type: 'step_start'; step: number }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use_start'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_end'; id: string; name: string; ok: boolean; output: string; durationMs: number }
  | { type: 'step_end'; step: number; stopReason: string; inputTokens: number; outputTokens: number }
  | { type: 'turn_end'; text: string; steps: number; stoppedByLimit: boolean }
  /** Falha do turno (não é erro de tool — é o agente que desistiu). */
  | { type: 'error'; code: string; message: string }

/** Resumo de um turno já concluído. */
export interface TurnSummary {
  text: string
  steps: number
  toolCount: number
  stoppedByLimit: boolean
}

/**
 * Uma entrada da conversa, pronta a mostrar no ecrã.
 *
 * O ficheiro de sessão guarda os registos cruos do loop (mensagens, tools,
 * checkpoints); isto é a projecção deles para a UI: só o que faz parte da
 * conversa, com o `tool_use` e o `tool_result` já fundidos numa entrada só —
 * a UI não precisa de saber como o formato persiste as tools.
 */
export type HistoryEntry =
  | { kind: 'user'; text: string; at: number }
  | { kind: 'assistant'; text: string; at: number }
  | { kind: 'tool'; id: string; name: string; at: number; ok?: boolean; output?: string }

/** Opções para criar uma sessão. */
export interface CreateSessionOptions {
  /** Directório de trabalho da sessão. Default: o do host. */
  cwd?: string
  /** Referência de modelo (`deepseek/deepseek-flash`). */
  model?: string
  /** Título legível. */
  title?: string
}

/** Uma sessão vista pelo transporte. */
export interface SessionHandle {
  readonly id: string
  readonly cwd: string
  readonly model: string
  readonly modelRef: string
  readonly title: string
  readonly createdAt: number
  /** Há um turno em curso? */
  readonly running: boolean
  /**
   * Corre um turno, emitindo eventos pela ordem em que acontecem.
   *
   * `onEvent` é síncrono e não pode bloquear: o produtor não espera pelo
   * consumidor (a ponte para o fio faz o buffer).
   */
  run(text: string, onEvent: (event: AgentEvent) => void, signal?: AbortSignal): Promise<TurnSummary>
  /** Pede cancelamento do turno em curso (no-op se não houver nenhum). */
  cancel(): void
  /**
   * Histórico da conversa persistido, pronto a mostrar.
   *
   * É o que permite reabrir a UI sem perder a transcrição: a sessão vive no
   * disco e aqui devolve-se já no formato do ecrã (vazio se ainda não houver
   * turnos).
   */
  history(): HistoryEntry[]
}

/** Dados de uma sessão, prontos a serializar. */
export interface SessionInfo {
  id: string
  cwd: string
  model: string
  modelRef: string
  title: string
  createdAt: number
  running: boolean
}

/** A porta que o host implementa por trás dos controllers. */
export interface AgentHost {
  create(options: CreateSessionOptions): Promise<SessionHandle>
  get(id: string): SessionHandle | undefined
  list(): SessionHandle[]
  remove(id: string): Promise<void>
}

/** Opções dos remotes. */
export interface RemotesOptions {
  /** Porta do agente. */
  host: AgentHost
  /** Directório de trabalho por omissão do host. */
  cwd: string
  /** Directório de dados (`~/.open-harness`). */
  home: string
  /** Versão do host, para `/api/health` e `settings.get`. */
  version?: string
  /** Teto de bytes lidos de um ficheiro. Default 1 MiB. */
  maxReadBytes?: number
  /** Leitura das definições compostas, para `settings.get`. */
  readSettings?(): Record<string, unknown>
}

/** Dados de uma entrada de workspace (`workspace.files.list`). */
export interface WorkspaceEntry {
  path: string
  name: string
  kind: 'file' | 'dir'
  size: number
  mtimeMs: number
}

/** Converte um handle no objecto serializável. */
export function sessionInfo(handle: SessionHandle): SessionInfo {
  return {
    id: handle.id,
    cwd: handle.cwd,
    model: handle.model,
    modelRef: handle.modelRef,
    title: handle.title,
    createdAt: handle.createdAt,
    running: handle.running,
  }
}
