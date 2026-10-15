// ---------------------------------------------------------------------------
// Cabeçalho de sessão (formato observado no dsh, v4)
// ---------------------------------------------------------------------------

/** Versão canónica do formato de sessão que este build escreve. */
export const SESSION_FORMAT_VERSION = 4 as const

/** Tipos de registo suportados no corpo da sessão. */
export type SessionRecordType =
  | 'message'
  | 'tool_use'
  | 'tool_result'
  | 'summary'
  | 'checkpoint'
  | 'system'

/** Cabeçalho — primeiro registo de qualquer `session.v4.jsonl`. */
export interface SessionHeader {
  type: 'session'
  version: number
  id: string
  createdAt: number
  cwd: string
  parentSession: string | null
  isSeeded: boolean
  delegationDepth: number
  agentPreset: string
}

/** Papel de uma mensagem. */
export type SessionRole = 'user' | 'assistant' | 'system'

/** Um bloco de conteúdo guardado numa mensagem. */
export interface SessionContentBlock {
  type: string
  text?: string
  [key: string]: unknown
}

/** Registo de corpo — o que se acumula ao longo da sessão. */
export interface SessionRecord {
  type: SessionRecordType
  /** Momento em ms desde o epoch. */
  timestamp: number
  /** Papel (para `message`). */
  role?: SessionRole
  /** Blocos de conteúdo (para `message`). */
  content?: SessionContentBlock[]
  /** Nome da tool (para `tool_use`). */
  name?: string
  /** Input da tool (para `tool_use`). */
  input?: unknown
  /** Id do `tool_use` a que se refere (para `tool_result`). */
  toolUseId?: string
  /** Output da tool (para `tool_result`). */
  output?: unknown
  /** Se o resultado foi um erro. */
  isError?: boolean
  /** Texto do resumo (para `summary`). */
  summary?: string
  /** Estado capturado (para `checkpoint`). */
  checkpoint?: unknown
}

/** Um ficheiro de sessão = cabeçalho + registos. */
export interface SessionFile {
  header: SessionHeader
  records: SessionRecord[]
}
