import { readdir, readFile, mkdir, stat, writeFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { RemoteError, type RemoteSpec } from '@open-harness/dsh-api-gateway'
import type { RemotesOptions, WorkspaceEntry } from './types.js'

/**
 * Resolve um caminho relativo para dentro da raiz, sem deixar sair.
 *
 * É a mesma defesa do servidor estático, aplicada aqui ao workspace: o browser
 * só deve conseguir tocar no que está dentro do directório de trabalho.
 */
export function resolveInside(root: string, relative: unknown): string {
  const clean = String(relative ?? '').replace(/\\/g, '/')
  if (clean.split('/').some((part) => part === '..')) {
    throw new RemoteError('invalid_params', 'path escapes the workspace')
  }
  const absolute = resolve(root, clean.replace(/^\/+/, ''))
  const base = resolve(root)
  if (absolute !== base && !absolute.startsWith(base + sep)) {
    throw new RemoteError('invalid_params', 'path escapes the workspace')
  }
  return absolute
}

/** Remote `workspace.*` — o que o host é, por dentro. */
export function workspaceRemote(options: RemotesOptions): RemoteSpec {
  return {
    namespace: 'workspace',
    methods: {
      info: {
        handler: () => ({
          cwd: resolve(options.cwd),
          home: resolve(options.home),
          platform: process.platform,
          version: options.version ?? '0.0.0',
        }),
      },
    },
  }
}

/**
 * Remote `workspace.files.*` — ler, listar e escrever no workspace.
 *
 * O browser é um editor do mesmo árvore de trabalho do agente, mas nunca sai
 * dela: todos os caminhos passam por `resolveInside`.
 */
export function workspaceFilesRemote(options: RemotesOptions): RemoteSpec {
  const root = resolve(options.cwd)
  const maxReadBytes = options.maxReadBytes ?? 1024 * 1024

  return {
    namespace: 'workspace.files',
    methods: {
      list: {
        handler: async (params: { path?: string }): Promise<{ path: string; entries: WorkspaceEntry[] }> => {
          const dir = resolveInside(root, params?.path ?? '')
          let dirents
          try {
            dirents = await readdir(dir, { withFileTypes: true })
          } catch {
            throw new RemoteError('invalid_params', `not a directory: ${String(params?.path ?? '')}`)
          }
          const entries: WorkspaceEntry[] = []
          for (const dirent of dirents) {
            const child = resolve(dir, dirent.name)
            let size = 0
            let mtimeMs = 0
            try {
              const info = await stat(child)
              size = info.size
              mtimeMs = info.mtimeMs
            } catch {
              // Ficheiro desaparecido entre o readdir e o stat — ignora.
              continue
            }
            entries.push({
              path: `${String(params?.path ?? '').replace(/\/+$/, '')}/${dirent.name}`.replace(/^\//, ''),
              name: dirent.name,
              kind: dirent.isDirectory() ? 'dir' : 'file',
              size,
              mtimeMs,
            })
          }
          entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1))
          return { path: String(params?.path ?? ''), entries }
        },
      },
      read: {
        handler: async (params: { path: string }) => {
          const file = resolveInside(root, params?.path)
          let info
          try {
            info = await stat(file)
          } catch {
            throw new RemoteError('invalid_params', `no such file: ${String(params?.path ?? '')}`)
          }
          if (info.size > maxReadBytes) {
            throw new RemoteError('invalid_params', `file too large (${info.size} > ${maxReadBytes} bytes)`)
          }
          return {
            path: String(params?.path ?? ''),
            content: await readFile(file, 'utf8'),
            size: info.size,
            mtimeMs: info.mtimeMs,
          }
        },
      },
      write: {
        handler: async (params: { path: string; content: string }) => {
          const file = resolveInside(root, params?.path)
          const content = typeof params?.content === 'string' ? params.content : ''
          await mkdir(resolve(file, '..'), { recursive: true })
          await writeFile(file, content, 'utf8')
          return { ok: true, path: String(params?.path ?? ''), bytes: Buffer.byteLength(content) }
        },
      },
    },
  }
}

/**
 * Remote `settings.*` — a composição que o host arrancou com.
 *
 * Sem escrita nesta leva: as definições vêm do perfil, e alterá-las a partir do
 * browser é uma decisão de autorização que ainda não tomámos.
 */
export function settingsRemote(options: {
  read(): Record<string, unknown>
}): RemoteSpec {
  return {
    namespace: 'settings',
    methods: {
      get: { handler: () => options.read() },
    },
  }
}
