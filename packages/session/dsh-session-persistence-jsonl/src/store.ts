import { mkdir, open } from 'node:fs/promises'
import { dirname } from 'node:path'
import { migrateToCurrent, type SessionFile, type SessionHeader, type SessionRecord } from '@open-harness/dsh-session-format'
import { decodeFrame, encodeFrame, type Compression } from './frame.js'

export interface SaveOptions {
  compression?: Compression
}

/**
 * Grava uma sessão como JSONL: cabeçalho (linha 1, JSON cru) + um frame por
 * registo. Cada frame é escrito e fechado (flush) individualmente, para que
 * um corte a meio deixe só o último frame incompleiro — o resto fica íntegro.
 */
export async function saveSession(file: SessionFile, filePath: string, options: SaveOptions = {}): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const handle = await open(filePath, 'w')
  try {
    await handle.writeFile(`${JSON.stringify(file.header)}\n`, 'utf8')
    for (const record of file.records) {
      const frame = await encodeFrame(record, options)
      await handle.writeFile(`${frame}\n`, 'utf8')
    }
  } finally {
    await handle.close()
  }
}

/** Resultado de uma leitura, com o que foi recuperado/descartado. */
export interface LoadResult extends SessionFile {
  /** Registos descartados por corrupção/ausência de checksum. */
  droppedFrames: number
  /** O ficheiro terminava com um frame incompleiro (torn-tail). */
  truncated: boolean
}

export class SessionPersistenceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'SessionPersistenceError'
  }
}

/**
 * Lê uma sessão. Recuperação de torn-tail: frames ilegíveis no fim são
 * descartados e reportados em `droppedFrames`/`truncated`, sem perder os
 * registos anteriores. Migra o cabeçalho para a versão canónica.
 */
export async function loadSession(filePath: string, options: SaveOptions = {}): Promise<LoadResult> {
  const handle = await open(filePath, 'r')
  let text: string
  try {
    text = await handle.readFile('utf8')
  } finally {
    await handle.close()
  }

  const lines = text.split('\n')
  const headerLine = lines[0]
  if (headerLine === undefined || headerLine.trim() === '') {
    throw new SessionPersistenceError(`session file is empty: ${filePath}`)
  }

  let header: SessionHeader
  try {
    header = JSON.parse(headerLine) as SessionHeader
  } catch (error) {
    throw new SessionPersistenceError(`invalid session header: ${(error as Error).message}`, { cause: error })
  }

  const frameLines = lines.slice(1).filter((line) => line.trim() !== '')
  const records: SessionRecord[] = []
  let droppedFrames = 0
  let truncated = false

  for (const line of frameLines) {
    try {
      records.push((await decodeFrame(line, options)) as SessionRecord)
    } catch (error) {
      // Frame ilegível → descartamos e reportamos. Se for o último, é o
      // torn-tail esperado após corte abrupto; se não, há corrupção no meio,
      // mas não perdemos o que já lemos.
      droppedFrames += 1
      truncated = true
    }
  }

  const migrated = migrateToCurrent({ header, records })
  return { ...migrated, droppedFrames, truncated }
}
