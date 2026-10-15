import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { ToolDefinition } from '@open-harness/dsh-tools'

/** Teto de bytes lidos pela tool `read` (protege o contexto). */
export const MAX_READ_BYTES = 512 * 1024
/** Teto de bytes escritos pela tool `write`. */
export const MAX_WRITE_BYTES = 2 * 1024 * 1024

function text(input: Record<string, unknown>, key: string): string {
  const value = input[key]
  if (typeof value !== 'string') throw new Error(`missing or non-string "${key}"`)
  return value
}

/** `read` — lê um ficheiro como texto, com teto de tamanho. */
export function readTool(): ToolDefinition {
  return {
    name: 'read',
    description: 'Read a UTF-8 text file and return its contents.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'File path (absolute or relative to cwd)' } },
      required: ['path'],
    },
    async execute(input, ctx) {
      const path = resolve(ctx.cwd, text(input, 'path'))
      const content = await readFile(path, 'utf8')
      const truncated =
        content.length > MAX_READ_BYTES
          ? `\n\n[truncated: file exceeds ${MAX_READ_BYTES} bytes]`
          : ''
      return { content: content.slice(0, MAX_READ_BYTES) + truncated }
    },
  }
}

/** `write` — cria/substitui um ficheiro de texto. */
export function writeTool(): ToolDefinition {
  return {
    name: 'write',
    description: 'Create or overwrite a UTF-8 text file with the given content.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        content: { type: 'string', description: 'Full file content' },
      },
      required: ['path', 'content'],
    },
    async execute(input, ctx) {
      const path = resolve(ctx.cwd, text(input, 'path'))
      const content = text(input, 'content')
      if (content.length > MAX_WRITE_BYTES) throw new Error(`content exceeds ${MAX_WRITE_BYTES} bytes`)
      // Cria o directório pai se não existir — um agente escreve `sub/c.txt`
      // sem ter de saber se `sub/` existe.
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, content, 'utf8')
      return { content: `wrote ${content.length} bytes to ${path}` }
    },
  }
}

/** `edit` — substitui uma ocorrência exacta; falha se não for única. */
export function editTool(): ToolDefinition {
  return {
    name: 'edit',
    description: 'Replace an exact string in a file. The old string must occur exactly once.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        old_string: { type: 'string', description: 'Exact text to replace (must be unique)' },
        new_string: { type: 'string', description: 'Replacement text' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    async execute(input, ctx) {
      const path = resolve(ctx.cwd, text(input, 'path'))
      const oldString = text(input, 'old_string')
      const newString = text(input, 'new_string')
      if (oldString === '') throw new Error('old_string must not be empty')
      const content = await readFile(path, 'utf8')
      const first = content.indexOf(oldString)
      if (first < 0) throw new Error('old_string not found')
      if (content.indexOf(oldString, first + 1) >= 0) throw new Error('old_string is not unique')
      const next = content.slice(0, first) + newString + content.slice(first + oldString.length)
      await writeFile(path, next, 'utf8')
      return { content: `edited ${path}` }
    },
  }
}

/** As três tools de filesystem do agente. */
export function fsTools(): ToolDefinition[] {
  return [readTool(), writeTool(), editTool()]
}
