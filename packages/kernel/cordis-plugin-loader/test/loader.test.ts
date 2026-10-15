import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { Context, InvalidPluginError } from '@open-harness/cordis'
import {
  PluginLoader,
  instantiatePlugin,
  loadEntries,
  resolveModulePath,
  type PluginEntry,
} from '@open-harness/cordis-plugin-loader'

const fixturesDir = fileURLToPath(new URL('./fixtures/', import.meta.url))
const tempDirs: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

describe('PluginLoader.load', () => {
  it('carrega linhas, reporta saltos/falhas e activa por serviço (ordem irrelevante)', async () => {
    const root = new Context()
    const modules: Record<string, unknown> = {
      'p-provider': { name: 'provider', apply: (ctx: Context, config: { value: string }) => ctx.set('dep', config.value) },
      'p-consumer': {
        name: 'consumer',
        inject: ['dep'],
        apply: (ctx: Context) => ctx.set('out', `${ctx.get<string>('dep')}!`),
      },
    }

    const report = await loadEntries(
      root,
      [
        { id: 'consumer', plugin: 'p-consumer' },
        { id: 'provider', plugin: 'p-provider', config: { value: 'ok' } },
        { id: 'disabled', plugin: 'p-provider', enabled: false },
        { id: 'config-only', plugin: null, config: { x: 1 } },
        { id: 'broken', plugin: 'missing' },
      ],
      {
        importModule: async (specifier) => {
          if (!(specifier in modules)) throw new Error(`not found: ${specifier}`)
          return modules[specifier]
        },
      },
    )

    expect([...report.applied].sort()).toEqual(['consumer', 'provider'])
    expect(report.skipped).toEqual([
      { id: 'disabled', reason: 'disabled' },
      { id: 'config-only', reason: 'config-only' },
    ])
    expect(report.failed).toHaveLength(1)
    expect(report.failed[0]?.id).toBe('broken')
    expect(report.failed[0]?.reason).toBe('resolve')
    expect(root.get('out')).toBe('ok!')
  })

  it('carrega duas linhas do mesmo módulo como fibras independentes', async () => {
    const root = new Context()
    const loader = new PluginLoader(root, { requireDir: fixturesDir })
    const report = await loader.load([
      { id: 'a', plugin: './plain-plugin.mjs', config: { value: 'alpha' } },
      { id: 'b', plugin: './plain-plugin.mjs', config: { value: 'beta' } },
    ])
    expect(report.failed).toEqual([])
    expect(report.applied).toEqual(['a', 'b'])
    // módulo é cacheado, mas cada linha tem a sua fibra e o seu registo de serviço
    expect(loader.entries).toHaveLength(2)
    expect(root.children).toHaveLength(2)
    expect(root.getAll('plain.values')).toEqual(['alpha', 'beta'])
  })
})

describe('PluginLoader — resolução de módulos', () => {
  it('resolve caminho relativo ao requireDir', async () => {
    const root = new Context()
    const loader = new PluginLoader(root, { requireDir: fixturesDir })
    const report = await loader.load([{ id: 'hot', plugin: './hot-plugin.mjs', config: { value: 'relative' } }])
    expect(report.failed).toEqual([])
    expect(root.get('hot.value')).toBe('relative')
  })

  it('resolve nome de pacote via node_modules (require.resolve)', async () => {
    const dir = tempDir('dsh-loader-')
    const pkgDir = join(dir, 'node_modules', 'fake-plugin')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'fake-plugin', version: '1.0.0', type: 'module', main: 'index.js' }),
    )
    writeFileSync(join(pkgDir, 'index.js'), 'export default { apply(ctx) { ctx.set("fake.ok", true) } }\n')

    const root = new Context()
    const loader = new PluginLoader(root, { requireDir: dir })
    const report = await loader.load([{ id: 'fake', plugin: 'fake-plugin' }])
    expect(report.failed).toEqual([])
    expect(report.applied).toEqual(['fake'])
    expect(root.get('fake.ok')).toBe(true)
  })

  it('especificador irresolveável é erro claro', async () => {
    const dir = tempDir('dsh-loader-missing-')
    await expect(resolveModulePath('definitely-not-a-real-pkg-xyz', dir)).rejects.toThrow(/cannot resolve/)
  })
})

describe('PluginLoader.update (diff para HMR)', () => {
  it('reconfigura em quente, reinicia sem caminho quente e remove linhas', async () => {
    const root = new Context()
    const loader = new PluginLoader(root, { requireDir: fixturesDir })

    const initial: PluginEntry[] = [
      { id: 'hot', plugin: './hot-plugin.mjs', config: { value: 'one' } },
      { id: 'cold', plugin: './cold-plugin.mjs', config: { value: 'one' } },
      { id: 'cls', plugin: './class-plugin.mjs', config: { value: 'one' } },
    ]
    const first = await loader.load(initial)
    expect(first.failed).toEqual([])
    expect(root.get('hot.value')).toBe('one')

    const hotStats = root.get<{ apply: number; reconfigure: number; disposed: number }>('hot.stats')
    const coldStats = root.get<{ apply: number; disposed: number }>('cold.stats')
    const classStats = root.get<{ apply: number }>('class.stats')
    const hotApply0 = hotStats.apply
    const coldApply0 = coldStats.apply
    const classApply0 = classStats.apply
    const hotReconf0 = hotStats.reconfigure

    // 1) só config muda → o plugin com `reconfigure` actualiza sem reiniciar
    const changed: PluginEntry[] = initial.map((entry) => ({ ...entry, config: { value: 'two' } }))
    const upd1 = await loader.update(changed)
    expect(upd1.reconfigured).toEqual(['hot'])
    expect([...upd1.restarted].sort()).toEqual(['cls', 'cold'])
    expect([...upd1.applied].sort()).toEqual(['cls', 'cold'])
    expect(root.get('hot.value')).toBe('two')
    expect(root.get('cold.value')).toBe('two')
    expect(root.get('class.value')).toBe('two')

    expect(hotStats.apply).toBe(hotApply0) // fibra de `hot` não reiniciou
    expect(hotStats.reconfigure).toBe(hotReconf0 + 1)
    expect(hotStats.disposed).toBe(0)
    expect(coldStats.apply).toBe(coldApply0 + 1) // função sem reconfigure → reinício
    expect(classStats.apply).toBe(classApply0 + 1) // classe sem reconfigure → reinício

    // 2) documento idêntico → nenhum trabalho
    const upd2 = await loader.update(changed)
    expect(upd2.applied).toEqual([])
    expect(upd2.reconfigured).toEqual([])
    expect(upd2.restarted).toEqual([])
    expect(upd2.removed).toEqual([])

    // 3) remoção e desabilitação limpam as fibras
    const upd3 = await loader.update([
      { id: 'hot', plugin: './hot-plugin.mjs', config: { value: 'two' } },
      { id: 'cold', plugin: './cold-plugin.mjs', config: { value: 'two' }, enabled: false },
    ])
    expect([...upd3.removed].sort()).toEqual(['cls', 'cold'])
    expect(upd3.skipped).toEqual([{ id: 'cold', reason: 'disabled' }])
    expect(root.has('cold.value')).toBe(false)
    expect(root.has('class.value')).toBe(false)
    expect(root.get('hot.value')).toBe('two')
    expect(loader.entries.map((entry) => entry.id)).toEqual(['hot'])
  })

  it('mudança de plugin reinicia a linha (assinatura mudou)', async () => {
    const root = new Context()
    const loader = new PluginLoader(root, { requireDir: fixturesDir })
    await loader.load([{ id: 'row', plugin: './cold-plugin.mjs', config: { value: 'one' } }])

    const upd = await loader.update([{ id: 'row', plugin: './class-plugin.mjs', config: { value: 'one' } }])
    expect(upd.restarted).toEqual(['row'])
    expect(upd.reconfigured).toEqual([])
    expect(root.get('class.value')).toBe('one')
    expect(root.has('cold.value')).toBe(false)
  })
})

describe('PluginLoader — grupos e unload', () => {
  it('group+isolate cria fibra partilhada; unload limpa tudo', async () => {
    const root = new Context()
    const loader = new PluginLoader(root, { requireDir: fixturesDir })
    const report = await loader.load([
      { id: 'g1', plugin: './cold-plugin.mjs', group: 'g', isolate: true, config: { value: 'a' } },
      { id: 'g2', plugin: './hot-plugin.mjs', group: 'g', isolate: true, config: { value: 'b' } },
      { id: 'plain', plugin: './class-plugin.mjs', config: { value: 'c' } },
    ])
    expect(report.failed).toEqual([])
    expect(report.applied).toHaveLength(3)

    const groups = loader.groupContexts
    expect(groups).toHaveLength(1)
    expect(groups[0]?.children).toHaveLength(2)
    expect(root.children).toHaveLength(2) // grupo + linha sem grupo

    await loader.unload()
    expect(loader.groupContexts).toHaveLength(0)
    expect(loader.entries).toEqual([])
    expect(root.children).toHaveLength(0)
  })

  it('load só pode correr uma vez; depois use update', async () => {
    const root = new Context()
    const loader = new PluginLoader(root, { requireDir: fixturesDir })
    await loader.load([{ id: 'x', plugin: './cold-plugin.mjs' }])
    await expect(loader.load([])).rejects.toThrow(/already loaded/)
    // update com documento vazio equivale a descarregar
    const upd = await loader.update([])
    expect(upd.removed).toEqual(['x'])
    expect(root.children).toHaveLength(0)
  })
})

describe('instantiatePlugin', () => {
  it('aceita classe, função e objecto; rejeita exports inválidos', () => {
    class Named {
      apply(): void {}
      reconfigure(): void {}
    }
    const fromClass = instantiatePlugin('c', Named)
    expect(fromClass.name).toBe('Named')
    expect(typeof fromClass.apply).toBe('function')
    expect(typeof fromClass.reconfigure).toBe('function')

    function namedFn(): void {}
    const fromFn = instantiatePlugin('f', namedFn)
    expect(fromFn.name).toBe('namedFn')
    expect(fromFn.reconfigure).toBeUndefined()

    const shared = { apply(): void {}, state: 0 }
    const a = instantiatePlugin('s', shared)
    const b = instantiatePlugin('s', shared)
    expect(a).not.toBe(b) // clone por linha
    expect((a as unknown as { state: number }).state).toBe(0)
    expect(shared.state).toBe(0)

    expect(() => instantiatePlugin('bad', { notApply: true })).toThrow(InvalidPluginError)
    expect(() => instantiatePlugin('bad2', 42)).toThrow(InvalidPluginError)
    expect(() => instantiatePlugin('bad3', class NoApply {})).toThrow(/apply/)
  })

  it('desembrulha default de módulo ESM/CJS', () => {
    const fn = (): void => {}
    expect(instantiatePlugin('m1', { default: fn })).toBeTypeOf('object')
    expect(() => instantiatePlugin('m2', { default: { not: 1 } })).toThrow(InvalidPluginError)
  })
})
