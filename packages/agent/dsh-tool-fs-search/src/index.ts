import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { ToolDefinition } from '@open-harness/dsh-tools'

/** Teto de ficheiros devolvidos por `glob`. */
export const MAX_GLOB_RESULTS = 200
/** Teto de linhas devolvidas por `grep`. */
export const MAX_GREP_RESULTS = 200
/** Tamanho máximo de ficheiro examinado pelo `grep`. */
export const MAX_GREP_BYTES = 1024 * 1024

/**
 * Converte um padrão glob comum (`*`, `**`, `?`) para RegExp. Suporta a
 * subset usada por procura de ficheiros: `*` (não cruza `/`), `**` (cruza),
 * `?` (um carácter).
 */
export function globToRegExp(pattern: string): RegExp {
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        // `**` — zero ou mais segmentos
        out += '.*'
        i++
        // `**/` deve também casar zero segmentos (a barra é opcional)
        if (pattern[i + 1] === '/') {
          out += '?'
          i++
        }
      } else {
        out += '[^/]*'
      }
    } else if (char === '?') {
      out += '[^/]'
    } else if ('\\^$.|+()[]{}'.includes(char)) {
      out += `\\${char}`
    } else {
      out += char
    }
  }
  return new RegExp(`^${out}$`)
}

async function* walk(dir: string, signal?: AbortSignal): AsyncGenerator<string> {
  if (signal?.aborted) return
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (signal?.aborted) return
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full, signal)
    else if (entry.isFile()) yield full
  }
}

/** `glob` — lista ficheiros cujo caminho relativo casa com o padrão. */
export function globTool(): ToolDefinition {
  return {
    name: 'glob',
    description: 'Find files whose relative path matches a glob pattern (e.g. **/*.ts).',
    inputSchema: {
      type: 'object',
      properties: { pattern: { type: 'string', description: 'Glob pattern' } },
      required: ['pattern'],
    },
    async execute(input, ctx) {
      const pattern = String(input.pattern ?? '')
      const matcher = globToRegExp(pattern)
      const matches: string[] = []
      for await (const file of walk(ctx.cwd, ctx.signal)) {
        const rel = relative(ctx.cwd, file).split(sep).join('/')
        if (matcher.test(rel)) {
          matches.push(rel)
          if (matches.length >= MAX_GLOB_RESULTS) break
        }
      }
      matches.sort()
      const note = matches.length >= MAX_GLOB_RESULTS ? `\n[truncated at ${MAX_GLOB_RESULTS}]` : ''
      return { content: matches.length ? matches.join('\n') + note : 'no matches' }
    },
  }
}

/** `grep` — procura uma expressão regular em ficheiros, devolvendo linhas. */
export function grepTool(): ToolDefinition {
  return {
    name: 'grep',
    description: 'Search file contents with a regular expression; returns matching lines.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression' },
        path: { type: 'string', description: 'Directory to search (default: cwd)' },
        include: { type: 'string', description: 'Optional glob to filter files (e.g. *.ts)' },
      },
      required: ['pattern'],
    },
    async execute(input, ctx) {
      const pattern = String(input.pattern ?? '')
      const regex = new RegExp(pattern)
      const include = typeof input.include === 'string' ? globToRegExp(input.include) : null
      const root = input.path ? join(ctx.cwd, String(input.path)) : ctx.cwd
      await stat(root) // falha cedo se o directório não existir

      const out: string[] = []
      let truncated = false
      for await (const file of walk(root, ctx.signal)) {
        const rel = relative(ctx.cwd, file).split(sep).join('/')
        if (include && !include.test(rel)) continue
        let content: string
        try {
          const bytes = await readFile(file)
          if (bytes.length > MAX_GREP_BYTES) continue
          content = bytes.toString('utf8')
        } catch {
          continue // binário ou ilegível — ignora
        }
        const lines = content.split(/\r?\n/)
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i]!)) {
            out.push(`${rel}:${i + 1}:${lines[i]!}`)
            if (out.length >= MAX_GREP_RESULTS) {
              truncated = true
              break
            }
          }
        }
        if (truncated) break
      }
      const note = truncated ? `\n[truncated at ${MAX_GREP_RESULTS}]` : ''
      return { content: out.length ? out.join('\n') + note : 'no matches' }
    },
  }
}

/** As duas tools de procura do agente. */
export function searchTools(): ToolDefinition[] {
  return [globTool(), grepTool()]
}
