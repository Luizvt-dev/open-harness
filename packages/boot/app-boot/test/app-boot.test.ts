import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { BootError, bootApp } from '@open-harness/app-boot'
import { Hmr } from '@open-harness/hmr'
import { PATCH_FILE } from '@open-harness/profile-boot'

const tempDirs: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

interface HotStats {
  apply: number
  reconfigure: number
  disposed: number
}

/** Plugin quente com contadores observáveis via serviços. */
const HOT_PLUGIN = `
const stats = { apply: 0, reconfigure: 0, disposed: 0 }
export default {
  apply(ctx, config) {
    stats.apply += 1
    this.ctx = ctx
    ctx.set('hot.value', config.value ?? 'initial')
    ctx.set('hot.stats', stats)
    ctx.effect(() => () => { stats.disposed += 1 })
  },
  reconfigure(config) {
    stats.reconfigure += 1
    this.ctx.set('hot.value', config.value ?? 'initial')
  },
}
`

/** Monta um perfil completo: bundle com plugin, perfil e home. */
function makeAppProfile(): { root: string; profileDir: string; homeDir: string; bundleDir: string } {
  const root = tempDir('dsh-app-')
  const profileDir = join(root, 'profile')
  const homeDir = join(root, 'home')
  const bundleDir = join(profileDir, 'bundles', 'base')
  mkdirSync(bundleDir, { recursive: true })
  mkdirSync(homeDir, { recursive: true })

  writeFileSync(
    join(profileDir, 'package.json'),
    JSON.stringify({ name: 'app', dsh: { profile: { bundles: ['./bundles/base'] } } }),
  )
  writeFileSync(join(bundleDir, 'hot.mjs'), HOT_PLUGIN)
  writeFileSync(join(bundleDir, PATCH_FILE), 'hot:\n  plugin: ./hot.mjs\n  config:\n    value: one\n')
  // patch ao nível do perfil (existe para ser observável pelo HMR)
  writeFileSync(join(profileDir, PATCH_FILE), '# o perfil pode sobrepor linhas dos bundles\n')
  return { root, profileDir, homeDir, bundleDir }
}

describe('bootApp', () => {
  it('compõe o perfil e carrega as linhas (requireDir por linha resolve o plugin do bundle)', async () => {
    const { profileDir, homeDir } = makeAppProfile()
    const boot = await bootApp({ profileDir, homeDir })
    try {
      expect(boot.report.applied).toEqual(['hot'])
      expect(boot.report.failed).toEqual([])
      expect(boot.ctx.get('hot.value')).toBe('one')
      // o loader vive dentro do boot e as linhas reflectem a composição
      expect(boot.loader.entries.map((entry) => entry.id)).toEqual(['hot'])
      expect(boot.composition.layers.map((layer) => layer.source)).toEqual(['bundle:./bundles/base', 'profile'])
    } finally {
      await boot.shutdown()
    }
  })

  it('reload recompõe e reconfigura em quente (sem reiniciar a fibra)', async () => {
    const { profileDir, homeDir, bundleDir } = makeAppProfile()
    const boot = await bootApp({ profileDir, homeDir })
    try {
      const stats = boot.ctx.get<HotStats>('hot.stats')
      expect(stats.apply).toBe(1)

      // edita o patch do bundle e recarrega — caminho do HMR
      writeFileSync(join(bundleDir, PATCH_FILE), 'hot:\n  plugin: ./hot.mjs\n  config:\n    value: two\n')
      const update = await boot.reload()

      expect(update.reconfigured).toEqual(['hot'])
      expect(update.restarted).toEqual([])
      expect(update.removed).toEqual([])
      expect(boot.ctx.get('hot.value')).toBe('two')
      // fibra preservada: nem apply novo, nem dispose
      expect(stats.apply).toBe(1)
      expect(stats.reconfigure).toBe(1)
      expect(stats.disposed).toBe(0)
      // a composição reflecte o novo ficheiro
      expect(boot.composition.rows.find((row) => row.id === 'hot')?.config).toEqual({ value: 'two' })
    } finally {
      await boot.shutdown()
    }
  })

  it('shutdown descarrega todas as linhas', async () => {
    const { profileDir, homeDir } = makeAppProfile()
    const boot = await bootApp({ profileDir, homeDir })
    const stats = boot.ctx.get<HotStats>('hot.stats')
    await boot.shutdown()
    expect(boot.ctx.children).toHaveLength(0)
    expect(stats.disposed).toBe(1)
  })

  it('linha falhada: strict lança BootError com o relatório agarrado', async () => {
    const root = tempDir('dsh-app-bad-')
    const profileDir = join(root, 'profile')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, PATCH_FILE), 'bad:\n  plugin: ./missing.mjs\n')

    const failures: string[] = []
    await expect(
      bootApp({
        profileDir,
        homeDir: join(root, 'home'),
        onFailRow: (entry) => failures.push(entry.id),
      }),
    ).rejects.toThrow(BootError)

    try {
      await bootApp({ profileDir, homeDir: join(root, 'home') })
    } catch (error) {
      expect(error).toBeInstanceOf(BootError)
      const boot = error as BootError
      expect(boot.failed).toHaveLength(1)
      expect(boot.failed[0]?.id).toBe('bad')
      expect(boot.failed[0]?.reason).toBe('resolve')
    }
    expect(failures).toContain('bad') // onFailRow foi chamado antes de lançar
  })

  it('linha falhada: lenient só reporta', async () => {
    const root = tempDir('dsh-app-lenient-')
    const profileDir = join(root, 'profile')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, PATCH_FILE), ['bad:', '  plugin: ./missing.mjs', 'good: ./hot-ok.mjs'].join('\n'))
    mkdirSync(join(profileDir, 'plug'), { recursive: true })
    writeFileSync(
      join(profileDir, 'hot-ok.mjs'),
      'export default { apply(ctx) { ctx.set("ok", true) } }\n',
    )

    const boot = await bootApp({ profileDir, homeDir: join(root, 'home'), onRowError: 'lenient' })
    try {
      expect(boot.report.failed).toHaveLength(1)
      expect(boot.report.applied).toEqual(['good'])
      expect(boot.ctx.get('ok')).toBe(true)
    } finally {
      await boot.shutdown()
    }
  })

  it('linhas desabilitadas e só-de-config são reportadas como skipped', async () => {
    const { profileDir, homeDir, bundleDir } = makeAppProfile()
    writeFileSync(
      join(bundleDir, PATCH_FILE),
      ['hot:', '  plugin: ./hot.mjs', '  config:', '    value: one', 'off:', '  plugin: ./hot.mjs', '  enabled: false', 'cfg-only:', '  plugin: null'].join('\n'),
    )
    const boot = await bootApp({ profileDir, homeDir })
    try {
      expect(boot.report.applied).toEqual(['hot'])
      expect(boot.report.skipped).toEqual([
        { id: 'off', reason: 'disabled' },
        { id: 'cfg-only', reason: 'config-only' },
      ])
    } finally {
      await boot.shutdown()
    }
  })

  it('overlays entram na composição depois de tudo', async () => {
    const { root, profileDir, homeDir } = makeAppProfile()
    const overlay = join(root, 'extra.yml')
    writeFileSync(overlay, 'hot:\n  config:\n    value: overlaid\n')

    const boot = await bootApp({ profileDir, homeDir, overlays: [overlay] })
    try {
      expect(boot.ctx.get('hot.value')).toBe('overlaid')
      expect(boot.composition.layers.at(-1)?.source).toBe(`overlay:${overlay}`)
    } finally {
      await boot.shutdown()
    }
  })

  it('bundle required que falha propaga ProfileError do compose', async () => {
    const root = tempDir('dsh-app-bundle-')
    const profileDir = join(root, 'profile')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(
      join(profileDir, 'package.json'),
      JSON.stringify({ dsh: { profile: { bundles: ['./nao-existe'] } } }),
    )
    await expect(bootApp({ profileDir, homeDir: join(root, 'home') })).rejects.toThrow(/not found/)
  })
})

// ---------------------------------------------------------------------------
// Critério de aceite da Fase 1: alterar cordis.patch.yml sem reiniciar
// ---------------------------------------------------------------------------

describe('bootApp + Hmr (aceitação da Fase 1)', () => {
  it('escrever no patch do perfil dispara reload quente sem reiniciar a fibra', async () => {
    const { profileDir, homeDir } = makeAppProfile()
    const boot = await bootApp({ profileDir, homeDir })
    const hmr = new Hmr<void>({
      files: [join(profileDir, PATCH_FILE), join(profileDir, 'package.json')],
      debounce: 10,
      reload: async () => {
        await boot.reload()
      },
    })
    try {
      const stats = boot.ctx.get<HotStats>('hot.stats')
      expect(boot.ctx.get('hot.value')).toBe('one')

      hmr.start()
      // simula o utilizador a editar o patch do perfil
      writeFileSync(join(profileDir, PATCH_FILE), 'hot:\n  plugin: ./hot.mjs\n  config:\n    value: live\n')

      // espera até o valor quente reflectir (fs.watch é assíncrono)
      const deadline = Date.now() + 5000
      while (boot.ctx.get('hot.value') !== 'live' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      expect(boot.ctx.get('hot.value')).toBe('live')

      // a fibra NÃO reiniciou: reconfigure em quente, sem apply novo nem dispose
      expect(stats.apply).toBe(1)
      expect(stats.reconfigure).toBe(1)
      expect(stats.disposed).toBe(0)
    } finally {
      hmr.stop()
      await boot.shutdown()
    }
  })

  it('invalidate manual com o mesmo efeito (sem depender de fs.watch)', async () => {
    const { profileDir, homeDir, bundleDir } = makeAppProfile()
    const boot = await bootApp({ profileDir, homeDir })
    const hmr = new Hmr<void>({ reload: async () => { await boot.reload() } })
    try {
      const stats = boot.ctx.get<HotStats>('hot.stats')
      writeFileSync(join(bundleDir, PATCH_FILE), 'hot:\n  plugin: ./hot.mjs\n  config:\n    value: manual\n')
      await hmr.invalidate({ file: join(profileDir, PATCH_FILE) })
      expect(boot.ctx.get('hot.value')).toBe('manual')
      expect(stats.apply).toBe(1)
      expect(stats.reconfigure).toBe(1)
    } finally {
      await boot.shutdown()
    }
  })
})
