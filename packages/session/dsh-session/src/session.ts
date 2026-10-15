import {
  SESSION_FORMAT_VERSION,
  type SessionContentBlock,
  type SessionHeader,
  type SessionRecord,
  type SessionRole,
} from '@open-harness/dsh-session-format'

export interface SessionInit {
  id: string
  cwd: string
  agentPreset?: string
  parentSession?: string | null
  isSeeded?: boolean
  delegationDepth?: number
  createdAt?: number
}

/**
 * Uma sessão do agente: cabeçalho v4 + registos acumulados.
 *
 * A sessão é a fonte de verdade em memória; a persistência (JSONL/Zstd) vive
 * em `dsh-session-persistence-jsonl`, que consome `toFile()`.
 */
export class Session {
  readonly header: SessionHeader
  private readonly _records: SessionRecord[] = []

  constructor(init: SessionInit) {
    this.header = {
      type: 'session',
      version: SESSION_FORMAT_VERSION,
      id: init.id,
      createdAt: init.createdAt ?? Date.now(),
      cwd: init.cwd,
      parentSession: init.parentSession ?? null,
      isSeeded: init.isSeeded ?? false,
      delegationDepth: init.delegationDepth ?? 0,
      agentPreset: init.agentPreset ?? 'standard',
    }
  }

  get id(): string {
    return this.header.id
  }

  get records(): readonly SessionRecord[] {
    return this._records
  }

  get length(): number {
    return this._records.length
  }

  /** Registos já migrados/recebidos (imutável por convenção). */
  static fromFile(header: SessionHeader, records: SessionRecord[]): Session {
    const session = new Session({
      id: header.id,
      cwd: header.cwd,
      agentPreset: header.agentPreset,
      parentSession: header.parentSession,
      isSeeded: header.isSeeded,
      delegationDepth: header.delegationDepth,
      createdAt: header.createdAt,
    })
    session._records.push(...records)
    return session
  }

  append(record: SessionRecord): SessionRecord {
    this._records.push(record)
    return record
  }

  addMessage(role: SessionRole, content: Array<SessionContentBlock | string>, timestamp = Date.now()): SessionRecord {
    const blocks: SessionContentBlock[] = content.map((block) =>
      typeof block === 'string' ? { type: 'text', text: block } : block,
    )
    return this.append({ type: 'message', timestamp, role, content: blocks })
  }

  addUser(text: string, timestamp?: number): SessionRecord {
    return this.addMessage('user', [text], timestamp)
  }

  addAssistant(text: string, timestamp?: number): SessionRecord {
    return this.addMessage('assistant', [text], timestamp)
  }

  addToolUse(name: string, input: unknown, toolUseId: string, timestamp = Date.now()): SessionRecord {
    return this.append({ type: 'tool_use', timestamp, name, input, toolUseId })
  }

  addToolResult(toolUseId: string, output: unknown, isError = false, timestamp = Date.now()): SessionRecord {
    return this.append({ type: 'tool_result', timestamp, toolUseId, output, isError })
  }

  addSummary(summary: string, timestamp = Date.now()): SessionRecord {
    return this.append({ type: 'summary', timestamp, summary })
  }

  addCheckpoint(checkpoint: unknown, timestamp = Date.now()): SessionRecord {
    return this.append({ type: 'checkpoint', timestamp, checkpoint })
  }

  /** Snapshot para persistência (cabeçalho + registos). */
  toFile(): { header: SessionHeader; records: SessionRecord[] } {
    return { header: { ...this.header }, records: [...this._records] }
  }
}
