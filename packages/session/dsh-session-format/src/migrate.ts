import { SESSION_FORMAT_VERSION, type SessionFile, type SessionHeader } from './types.js'

// ---------------------------------------------------------------------------
// Catálogo de versões
// ---------------------------------------------------------------------------

/**
 * Versões conhecidas do formato de sessão. A v4 é a canónica (observada no
 * dsh). v0..v3 são reconstruídas por este projecto — o documento de análise
 * só expõe o cabeçalho v4, por isso as formas anteriores são uma genealogia
 * plausível que dá conteúdo real ao mecanismo de migração.
 */
export const KNOWN_VERSIONS = [0, 1, 2, 3, 4] as const
export type KnownVersion = (typeof KNOWN_VERSIONS)[number]

export function isKnownVersion(version: number): version is KnownVersion {
  return (KNOWN_VERSIONS as readonly number[]).includes(version)
}

/** Erro de migração/validação de formato. */
export class SessionFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SessionFormatError'
  }
}

/** Uma migração N → N+1. */
export interface Migration {
  readonly from: number
  readonly to: number
  migrate(input: unknown): unknown
}

// ---------------------------------------------------------------------------
// Migrações reconstruídas (v0 → v4)
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  throw new SessionFormatError(`expected an object, got ${typeof value}`)
}

function toArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (value === undefined || value === null) return []
  return [value]
}

/** v0 → v1: mensagens em `history` (texto simples) → registos `message`. */
const v0tov1: Migration = {
  from: 0,
  to: 1,
  migrate(input: unknown): unknown {
    const raw = asRecord(input)
    const header = asRecord(raw.header)
    const history = toArray(raw.history)
    const records = history.map((entry) => {
      const item = asRecord(entry)
      return { type: 'message', timestamp: Number(item.at ?? 0), role: String(item.role ?? 'user'), content: [{ type: 'text', text: String(item.text ?? '') }] }
    })
    return { header: { ...header, version: 1 }, records }
  },
}

/** v1 → v2: ganha `id`/`parentSession` no cabeçalho. */
const v1tov2: Migration = {
  from: 1,
  to: 2,
  migrate(input: unknown): unknown {
    const raw = asRecord(input)
    const header = asRecord(raw.header)
    return {
      header: { ...header, version: 2, id: String(header.id ?? ''), parentSession: header.parentSession ?? null },
      records: toArray(raw.records),
    }
  },
}

/** v2 → v3: tool_result ganha `toolUseId` explícito a ligar ao tool_use. */
const v2tov3: Migration = {
  from: 2,
  to: 3,
  migrate(input: unknown): unknown {
    const raw = asRecord(input)
    const header = asRecord(raw.header)
    // Mapa tool_use id/name → para ligar resultados órfãos pela ordem.
    const records = toArray(raw.records).map((entry) => {
      const item = asRecord(entry)
      if (item.type === 'tool_result' && item.toolUseId === undefined) {
        return { ...item, toolUseId: String(item.id ?? item.name ?? '') }
      }
      return item
    })
    return { header: { ...header, version: 3 }, records }
  },
}

/** v3 → v4: cabeçalho ganha `delegationDepth`, `isSeeded`, `agentPreset`. */
const v3tov4: Migration = {
  from: 3,
  to: 4,
  migrate(input: unknown): unknown {
    const raw = asRecord(input)
    const header = asRecord(raw.header)
    return {
      header: {
        ...header,
        version: 4,
        isSeeded: Boolean(header.isSeeded ?? false),
        delegationDepth: Number(header.delegationDepth ?? 0),
        agentPreset: String(header.agentPreset ?? 'standard'),
      },
      records: toArray(raw.records),
    }
  },
}

/** Migrações registadas, em ordem. */
export const MIGRATIONS: readonly Migration[] = [v0tov1, v1tov2, v2tov3, v3tov4]

// ---------------------------------------------------------------------------
// Migração de um ficheiro para a versão canónica
// ---------------------------------------------------------------------------

/** Migra `input` (ficheiro de sessão em qualquer versão conhecida) para a v4. */
export function migrateToCurrent(input: unknown, targetVersion: number = SESSION_FORMAT_VERSION): SessionFile {
  const raw = asRecord(input)
  const header = asRecord(raw.header)
  let version = Number(header.version ?? 0)
  if (!isKnownVersion(version)) {
    throw new SessionFormatError(`unknown session format version: ${String(header.version)}`)
  }

  // A forma de entrada depende da versão: a v0 usa `history` (texto simples),
  // as seguintes já usam `records`. Sem esta semente, a migração v0→v1 não
  // veria o histórico original.
  let current: unknown = version === 0 ? { header, history: toArray(raw.history) } : { header, records: toArray(raw.records) }
  while (version < targetVersion) {
    const step = MIGRATIONS.find((migration) => migration.from === version)
    if (!step) throw new SessionFormatError(`no migration from version ${version}`)
    current = step.migrate(current)
    version = step.to
  }
  if (version > targetVersion) {
    throw new SessionFormatError(`session version ${version} is newer than supported ${targetVersion}`)
  }

  const out = asRecord(current)
  return { header: out.header as SessionHeader, records: toArray(out.records) as SessionFile['records'] }
}
