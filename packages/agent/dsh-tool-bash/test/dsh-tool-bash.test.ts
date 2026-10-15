import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolRegistry } from '@open-harness/dsh-tools'
import { bashTool } from '@open-harness/dsh-tool-bash'
import type { ToolContext } from '@open-harness/dsh-tools'

let dir: string
let ctx: ToolContext
let registry: ToolRegistry
const isWindows = process.platform === 'win32'

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-bash-'))
  ctx = { cwd: dir }
  registry = new ToolRegistry().register(bashTool({ timeoutMs: 10_000 }))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('tool bash', () => {
  it('expõe bash para o wire', () => {
    expect(registry.toLlmTools().map((s) => s.name)).toEqual(['bash'])
  })

  it('captura stdout de comando simples', async () => {
    const command = isWindows ? 'Write-Output hello' : 'echo hello'
    const out = await registry.execute('bash', { command }, ctx)
    expect(out.ok).toBe(true)
    if (out.ok && typeof out.result.content === 'string') {
      expect(out.result.content).toContain('hello')
    }
  })

  it('corre no cwd da sessão', async () => {
    await writeFile(join(dir, 'marker.txt'), 'x')
    const command = isWindows ? 'Get-Content marker.txt' : 'cat marker.txt'
    const out = await registry.execute('bash', { command }, ctx)
    if (out.ok && typeof out.result.content === 'string') {
      expect(out.result.content).toContain('x')
    } else {
      expect.fail('bash falhou')
    }
  })

  it('marca isError em comando falhado', async () => {
    const command = 'exit 1'
    const out = await registry.execute('bash', { command }, ctx)
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.result.isError).toBe(true)
    }
  })

  it('capta stderr sem abortar', async () => {
    const command = isWindows
      ? 'Write-Error oops'
      : 'echo oops 1>&2'
    const out = await registry.execute('bash', { command }, ctx)
    expect(out.ok).toBe(true)
    if (out.ok && typeof out.result.content === 'string') {
      expect(out.result.content).toContain('oops')
    }
  })

  it('falha com comando vazio', async () => {
    const out = await registry.execute('bash', { command: '   ' }, ctx)
    expect(out.ok).toBe(false)
  })

  it('respeita timeout e marca killed', async () => {
    const command = isWindows
      ? 'Start-Sleep -Seconds 5'
      : 'sleep 5'
    const out = await registry.execute('bash', { command, timeout_ms: 300 }, ctx)
    expect(out.ok).toBe(true)
    if (out.ok && typeof out.result.content === 'string') {
      expect(out.result.content).toContain('[killed: timeout 300 ms]')
    }
  })

  it('aborta via AbortSignal', async () => {
    const controller = new AbortController()
    const command = isWindows ? 'Start-Sleep -Seconds 5' : 'sleep 5'
    const promise = registry.execute('bash', { command }, { cwd: dir, signal: controller.signal })
    setTimeout(() => controller.abort(), 100)
    const out = await promise
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.result.isError).toBe(true)
  })
})
