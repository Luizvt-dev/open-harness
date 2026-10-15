import { join } from 'node:path'

/**
 * Codifica um caminho de workspace para uso em nomes de directório.
 * Regra observada no dsh: `\` e `:` trocados por `-`.
 * Ex.: `C:\Users\Vortex\Downloads\Teste\` → `--C-Users-Vortex-Downloads-Teste-`
 */
export function encodeWorkspace(cwd: string): string {
  return cwd.replace(/[\\:]/g, '-')
}

/** Nome do ficheiro de sessão para uma versão e compressor. */
export function sessionFileName(version: number, compression: 'none' | 'zstd' = 'zstd'): string {
  return compression === 'zstd' ? `session.v${version}.jsonl.zstd` : `session.v${version}.jsonl`
}

export interface SessionPathsOptions {
  /** Raiz do home de dados (ex.: `~/.open-harness`). */
  home: string
  cwd: string
  sessionId: string
  version?: number
  compression?: 'none' | 'zstd'
}

/** Directório de uma sessão: `<home>/sessions/<workspace>/session-<id>`. */
export function sessionDir(home: string, cwd: string, sessionId: string): string {
  return join(home, 'sessions', encodeWorkspace(cwd), sessionId)
}

/** Caminho completo do ficheiro de uma sessão. */
export function sessionFilePath(options: SessionPathsOptions): string {
  const version = options.version ?? 4
  return join(sessionDir(options.home, options.cwd, options.sessionId), sessionFileName(version, options.compression))
}

/** Gera um id de sessão `session-<aleatório>`. */
export function newSessionId(): string {
  const random = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
  return `session-${random}`
}
