import { readFileSync } from 'node:fs'
import type { ApiKeySpec } from './types.js'

/** Ambiente injectável (default: o do processo). */
export type EnvLike = Record<string, string | undefined>

/** Variáveis de ambiente por omissão do processo. */
export function processEnv(): EnvLike {
  return process.env
}

/**
 * Resolve um segredo declarado como literal, `{ env: VAR }` ou `{ file: caminho }`.
 *
 * É a interpolação do OpenCode: permite manter chaves fora do YAML e lê-las do
 * ambiente ou de ficheiros (ex.: um auth.json) quando o arranque acontecer.
 */
export function resolveSecret(spec: ApiKeySpec | undefined, env: EnvLike = processEnv()): string {
  if (spec === undefined) return ''
  if (typeof spec === 'string') return spec
  if ('env' in spec) return env[spec.env] ?? ''
  try {
    return readFileSync(spec.file, 'utf8').trim()
  } catch {
    return ''
  }
}

/**
 * Resolve a primeira especificação com valor, por ordem. Devolve `''` se
 * nenhuma resolver — o chamador decide se isso é erro ou provedor local.
 */
export function resolveFirstSecret(specs: readonly ApiKeySpec[], env: EnvLike = processEnv()): string {
  for (const spec of specs) {
    const value = resolveSecret(spec, env)
    if (value) return value
  }
  return ''
}
