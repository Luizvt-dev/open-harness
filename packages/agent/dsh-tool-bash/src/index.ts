import { spawn } from 'node:child_process'
import type { ToolDefinition } from '@open-harness/dsh-tools'

/** Timeout por omissão da execução (ms). */
export const DEFAULT_TIMEOUT_MS = 60_000
/** Teto de bytes de stdout/stderr retidos. */
export const MAX_OUTPUT_BYTES = 256 * 1024

export interface BashToolOptions {
  /** Shell a usar. Default: `bash` em POSIX, `powershell.exe` em Windows. */
  shell?: string
  timeoutMs?: number
}

function defaultShell(): string {
  return process.platform === 'win32' ? 'powershell.exe' : 'bash'
}

function clip(text: string): string {
  if (text.length <= MAX_OUTPUT_BYTES) return text
  return text.slice(0, MAX_OUTPUT_BYTES) + `\n[truncated at ${MAX_OUTPUT_BYTES} bytes]`
}

/** `bash` — executa um comando no cwd do agente, capturando stdout/stderr. */
export function bashTool(options: BashToolOptions = {}): ToolDefinition {
  const shell = options.shell ?? defaultShell()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return {
    name: 'bash',
    description: 'Run a shell command in the working directory and return its output.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command to run' },
        timeout_ms: { type: 'number', description: 'Optional timeout in ms' },
      },
      required: ['command'],
    },
    async execute(input, ctx) {
      const command = String(input.command ?? '')
      if (!command.trim()) throw new Error('missing "command"')
      const timeout = typeof input.timeout_ms === 'number' ? input.timeout_ms : timeoutMs

      return await new Promise<{ content: string; isError?: boolean }>((resolve) => {
        const child = spawn(shell, shellIsPowerShell(shell) ? ['-NoProfile', '-Command', command] : ['-c', command], {
          cwd: ctx.cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
        })

        let stdout = ''
        let stderr = ''
        let killed = false
        const timer = setTimeout(() => {
          killed = true
          child.kill('SIGTERM')
        }, timeout)

        const onAbort = (): void => {
          killed = true
          child.kill('SIGTERM')
        }
        ctx.signal?.addEventListener('abort', onAbort, { once: true })

        child.stdout.on('data', (chunk: Buffer) => {
          if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString('utf8')
        })
        child.stderr.on('data', (chunk: Buffer) => {
          if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString('utf8')
        })

        const finish = (isError: boolean): void => {
          clearTimeout(timer)
          ctx.signal?.removeEventListener('abort', onAbort)
          const parts: string[] = []
          if (stdout) parts.push(clip(stdout))
          if (stderr) parts.push(`[stderr]\n${clip(stderr)}`)
          if (killed) parts.push(`[killed: timeout ${timeout} ms]`)
          resolve({ content: parts.join('\n') || '(no output)', isError })
        }

        child.on('error', (error) => {
          stderr += String(error.message)
          finish(true)
        })
        child.on('close', (code) => {
          if (killed) return finish(true)
          if (code !== 0 && stderr) return finish(true)
          resolve({ content: clip(stdout) || '(no output)', isError: code !== 0 })
        })
      })
    },
  }
}

function shellIsPowerShell(shell: string): boolean {
  const lower = shell.toLowerCase()
  return lower.includes('pwsh') || lower.includes('powershell')
}
