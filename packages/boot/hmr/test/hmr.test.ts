import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Deferred } from '@open-harness/cosmokit'
import { Hmr, type ReloadTrigger } from '@open-harness/hmr'

const tempDirs: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const active: Hmr<unknown>[] = []

afterEach(() => {
  for (const hmr of active.splice(0, active.length)) hmr.stop()
  for (const dir of tempDirs.splice(0, tempDirs.length)) rmSync(dir, { recursive: true, force: true })
})

function track<T>(hmr: Hmr<T>): Hmr<T> {
  active.push(hmr as unknown as Hmr<unknown>)
  return hmr
}

describe('Hmr — invalidate manual', () => {
  it('reload é invocado com os triggers e resolve com o resultado', async () => {
    const calls: ReloadTrigger[][] = []
    const hmr = track(
      new Hmr({
        reload: (triggers) => {
          calls.push(triggers)
          return 'ok'
        },
      }),
    )
    expect(await hmr.invalidate({ file: 'a.yml' })).toBe('ok')
    expect(calls).toEqual([[{ reason: 'manual', file: 'a.yml' }]])
  })

  it('invalidates durante um reload activo coalescem no seguinte', async () => {
    const gate = new Deferred<void>()
    const calls: ReloadTrigger[][] = []
    const hmr = track(
      new Hmr({
        reload: async (triggers) => {
          calls.push(triggers)
          if (calls.length === 1) await gate.promise // só o 1º reload bloqueia
          return calls.length
        },
      }),
    )
    const first = hmr.invalidate({ file: 'a' }) // arranca o reload 1 (active = true)
    // chegam enquanto o reload 1 corre → correm todos juntos no seguinte
    const second = hmr.invalidate({ file: 'b' })
    const third = hmr.invalidate({ file: 'c' })
    gate.resolve()
    expect(await first).toBe(1)
    expect(await second).toBe(2)
    expect(await third).toBe(2)
    expect(calls).toEqual([
      [{ reason: 'manual', file: 'a' }],
      [
        { reason: 'manual', file: 'b' },
        { reason: 'manual', file: 'c' },
      ],
    ])
  })

  it('nunca corre dois reloads em paralelo', async () => {
    let concurrent = 0
    let maxConcurrent = 0
    let runs = 0
    const hmr = track(
      new Hmr({
        reload: async () => {
          concurrent += 1
          maxConcurrent = Math.max(maxConcurrent, concurrent)
          runs += 1
          await sleep(20)
          concurrent -= 1
          return runs
        },
      }),
    )
    // disparo rápido: o primeiro arranca, os seguinte enfileiram e coalescem
    const all = [hmr.invalidate(), hmr.invalidate(), hmr.invalidate(), hmr.invalidate(), hmr.invalidate()]
    const results = await Promise.all(all)
    expect(maxConcurrent).toBe(1) // nunca em paralelo
    expect(runs).toBeGreaterThanOrEqual(1)
    expect(runs).toBeLessThanOrEqual(5)
    // todos os promises resolvem com um resultado de reload válido
    for (const result of results) expect(result).toBeGreaterThanOrEqual(1)
  })

  it('erro no reload rejeita o invalidate e chama onError', async () => {
    const errors: unknown[] = []
    const hmr = track(
      new Hmr({
        reload: () => {
          throw new Error('boom')
        },
        onError: (error) => errors.push(error),
      }),
    )
    await expect(hmr.invalidate()).rejects.toThrow('boom')
    expect(errors).toHaveLength(1)
    // o hmr continua utilizável depois do erro
    expect(hmr.running).toBe(false)
  })

  it('onReload recebe o resultado e os triggers', async () => {
    const events: { result: string; triggers: ReloadTrigger[] }[] = []
    const hmr = track(
      new Hmr({
        reload: () => 'done',
        onReload: (result, triggers) => events.push({ result, triggers }),
      }),
    )
    await hmr.invalidate({ reason: 'watch', file: 'x' })
    expect(events).toEqual([{ result: 'done', triggers: [{ reason: 'watch', file: 'x' }] }])
  })
})

describe('Hmr — fs.watch', () => {
  it('escrever no ficheiro observado agenda um reload (debounce)', async () => {
    const file = join(tempDir('dsh-hmr-watch-'), 'watched.txt')
    writeFileSync(file, 'v1')

    const triggers: ReloadTrigger[][] = []
    let resolveReload: (() => void) | undefined
    const done = new Promise<void>((resolve) => {
      resolveReload = resolve
    })
    const hmr = track(
      new Hmr({
        files: [file],
        debounce: 10,
        reload: (batch) => {
          triggers.push(batch)
          resolveReload?.()
        },
      }),
    )
    hmr.start()
    expect(hmr.watching).toBe(true)

    writeFileSync(file, 'v2')
    await done
    expect(triggers[0]?.[0]?.reason).toBe('watch')
    expect(triggers[0]?.[0]?.file).toBe(file)
  })

  it('ficheiro ausente não impede start; stop fecha os watchers', () => {
    const dir = tempDir('dsh-hmr-stop-')
    const hmr = track(new Hmr({ files: [join(dir, 'nao-existe.txt')], reload: () => undefined }))
    hmr.start()
    expect(hmr.watching).toBe(false) // nenhum watcher pegou
    hmr.stop()
    expect(hmr.watching).toBe(false)
  })

  it('stop cancela debounce pendente (nenhum reload tardio)', async () => {
    const file = join(tempDir('dsh-hmr-debounce-'), 'w.txt')
    writeFileSync(file, 'v1')
    let runs = 0
    const hmr = track(
      new Hmr({
        files: [file],
        debounce: 10,
        reload: () => {
          runs += 1
        },
      }),
    )
    hmr.start()
    writeFileSync(file, 'v2')
    hmr.stop() // antes do debounce disparar
    await sleep(40)
    expect(runs).toBe(0)
  })
})
