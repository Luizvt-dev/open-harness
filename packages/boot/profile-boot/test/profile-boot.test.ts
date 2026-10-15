import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import {
  PATCH_FILE,
  PatchError,
  ProfileError,
  composeProfile,
  defaultProfileDir,
  defaultResolveBundle,
  mergeLayers,
  parsePatch,
  profileExists,
  readPatchFile,
  type PatchLayer,
} from '@open-harness/profile-boot'

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

// ---------------------------------------------------------------------------
// parsePatch
// ---------------------------------------------------------------------------

describe('parsePatch', () => {
  it('normaliza atalhos: string → plugin, null → defaults', () => {
    const rows = parsePatch([
      'plugin-a:',
      'plugin-b: some/module',
      'plugin-c:',
      '  plugin: other/module',
      '  config:',
      '    x: 1',
    ].join('\n'))
    expect(rows).toEqual([
      { id: 'plugin-a' },
      { id: 'plugin-b', plugin: 'some/module' },
      { id: 'plugin-c', plugin: 'other/module', config: { x: 1 } },
    ])
  })

  it('documento vazio devolve []', () => {
    expect(parsePatch('')).toEqual([])
    expect(parsePatch('# só comentários\n')).toEqual([])
  })

  it('avalia expressões !!js no boot', () => {
    const rows = parsePatch('row:\n  plugin: mod\n  config:\n    answer: !!js 6 * 7\n')
    expect(rows[0]?.config).toEqual({ answer: 42 })
  })

  it('expressão !!js com avaliador injectável', () => {
    const rows = parsePatch('row:\n  plugin: mod\n  config:\n    v: !!js injected\n', {
      evaluate: (expression) => `eval:${expression}`,
    })
    expect(rows[0]?.config).toEqual({ v: 'eval:injected' })
  })

  it('erro de sintaxe YAML é PatchError com posição', () => {
    expect(() => parsePatch('a: [1, 2\n', { source: 'x.yml' })).toThrow(PatchError)
    try {
      parsePatch('a: [1, 2\n', { source: 'x.yml' })
    } catch (error) {
      expect((error as PatchError).message).toContain('x.yml')
    }
  })

  it('chave desconhecida é rejeitada (additional: forbid apanha typos)', () => {
    expect(() => parsePatch('row:\n  plugin: mod\n  confg: {}\n')).toThrow(PatchError)
  })

  it('erro de avaliação !!js é PatchError com a expressão', () => {
    expect(() => parsePatch('row:\n  plugin: !!js nope.undefined.prop\n')).toThrow(/!!js/)
  })
})

// ---------------------------------------------------------------------------
// mergeLayers
// ---------------------------------------------------------------------------

describe('mergeLayers', () => {
  it('último-por-id vence, mantendo a posição de primeira aparição', () => {
    const layers: PatchLayer[] = [
      {
        source: 'bundle:a',
        requireDir: '/a',
        rows: [
          { id: 'first', plugin: 'p1' },
          { id: 'second', plugin: 'p2' },
        ],
      },
      { source: 'home', requireDir: '/home', rows: [{ id: 'first', plugin: 'p3' }] },
    ]
    const rows = mergeLayers(layers)
    expect(rows.map((row) => row.id)).toEqual(['first', 'second'])
    expect(rows[0]?.plugin).toBe('p3')
    expect(rows[0]?.source).toBe('home')
    expect(rows[1]?.source).toBe('bundle:a')
  })

  it('config é substituído por inteiro (nunca merge em fundo)', () => {
    const rows = mergeLayers([
      { source: 'a', requireDir: '/a', rows: [{ id: 'r', plugin: 'p', config: { x: 1, y: 2 } }] },
      { source: 'b', requireDir: '/b', rows: [{ id: 'r', config: { y: 99 } }] },
    ])
    expect(rows[0]?.config).toEqual({ y: 99 }) // `x` desapareceu
  })

  it('config null/vazio reseta para {}', () => {
    const rows = mergeLayers([
      { source: 'a', requireDir: '/a', rows: [{ id: 'r', plugin: 'p', config: { x: 1 } }] },
      { source: 'b', requireDir: '/b', rows: [{ id: 'r', config: null }] },
    ])
    expect(rows[0]?.config).toEqual({})
  })

  it('metadados só mudam quando declarados; requireDir segue o declarante do plugin', () => {
    const rows = mergeLayers([
      {
        source: 'bundle:a',
        requireDir: '/bundle-a',
        rows: [{ id: 'r', plugin: './plug.mjs', order: 5, group: 'g', isolate: true }],
      },
      {
        source: 'home',
        requireDir: '/home',
        rows: [{ id: 'r', enabled: false }],
      },
    ])
    const row = rows[0]!
    expect(row.enabled).toBe(false)
    expect(row.plugin).toBe('./plug.mjs')
    expect(row.order).toBe(5)
    expect(row.group).toBe('g')
    expect(row.isolate).toBe(true)
    expect(row.requireDir).toBe('/bundle-a') // plugin declarado em bundle:a
    expect(row.source).toBe('home')
  })

  it('requireDir muda quando uma camada posterior declara outro plugin', () => {
    const rows = mergeLayers([
      { source: 'bundle:a', requireDir: '/bundle-a', rows: [{ id: 'r', plugin: './a.mjs' }] },
      { source: 'home', requireDir: '/home', rows: [{ id: 'r', plugin: './h.mjs' }] },
    ])
    expect(rows[0]?.requireDir).toBe('/home')
    expect(rows[0]?.plugin).toBe('./h.mjs')
  })
})

// ---------------------------------------------------------------------------
// composeProfile
// ---------------------------------------------------------------------------

describe('composeProfile', () => {
  /** Monta um perfil completo em disco: bundles, perfil, home e overlay. */
  function makeProfile(): { profileDir: string; homeDir: string; overlay: string } {
    const root = tempDir('dsh-profile-')
    const profileDir = join(root, 'profile')
    const homeDir = join(root, 'home')

    mkdirSync(join(profileDir, 'bundles', 'base'), { recursive: true })
    mkdirSync(join(profileDir, 'bundles', 'extra'), { recursive: true })
    mkdirSync(homeDir, { recursive: true })

    writeFileSync(
      join(profileDir, 'package.json'),
      JSON.stringify({
        name: 'meu-perfil',
        dsh: {
          profile: {
            bundles: ['./bundles/base', './bundles/extra', { name: './bundles/optional', required: false }],
          },
        },
      }),
    )
    writeFileSync(
      join(profileDir, 'bundles', 'base', PATCH_FILE),
      ['base:', '  plugin: ./base-plugin.mjs', '  config:', '    from: base', 'shared:', '  plugin: ./base-plugin.mjs', '  config:', '    v: 1'].join('\n'),
    )
    writeFileSync(
      join(profileDir, 'bundles', 'extra', PATCH_FILE),
      ['shared:', '  config:', '    v: 2'].join('\n'),
    )
    writeFileSync(join(profileDir, PATCH_FILE), ['shared:', '  config:', '    v: 3', 'home-only:'].join('\n'))
    writeFileSync(join(homeDir, PATCH_FILE), ['shared:', '  config:', '    v: 4'].join('\n'))

    const overlay = join(root, 'overlay.yml')
    writeFileSync(overlay, ['shared:', '  config:', '    v: 5'].join('\n'))

    return { profileDir, homeDir, overlay }
  }

  it('compõe bundles → perfil → home → overlays com último-por-id vence', () => {
    const { profileDir, homeDir, overlay } = makeProfile()
    const result = composeProfile({ profileDir, homeDir, overlays: [overlay] })

    expect(result.manifest?.name).toBe('meu-perfil')
    const shared = result.rows.find((row) => row.id === 'shared')!
    expect(shared.config).toEqual({ v: 5 }) // overlay venceu tudo
    expect(shared.plugin).toBe('./base-plugin.mjs') // plugin preservado do bundle base
    expect(shared.requireDir).toBe(join(profileDir, 'bundles', 'base'))

    const layers = result.layers.map((layer) => layer.source)
    expect(layers).toEqual([
      'bundle:./bundles/base',
      'bundle:./bundles/extra',
      'profile',
      'home',
      `overlay:${resolve(overlay)}`,
    ])
  })

  it('sem overlays a ordem para no home', () => {
    const { profileDir, homeDir } = makeProfile()
    const result = composeProfile({ profileDir, homeDir })
    const shared = result.rows.find((row) => row.id === 'shared')!
    expect(shared.config).toEqual({ v: 4 })
    expect(result.skipped).toEqual([{ bundle: './bundles/optional', reason: 'not-found' }])
  })

  it('bundle required:false que não resolve é saltado e reportado', () => {
    const { profileDir, homeDir } = makeProfile()
    const skips: { bundle: string; reason: string }[] = []
    const result = composeProfile({
      profileDir,
      homeDir,
      onSkip: (event) => skips.push(event),
    })
    expect(result.skipped).toEqual([{ bundle: './bundles/optional', reason: 'not-found' }])
    expect(skips).toEqual([{ bundle: './bundles/optional', reason: 'not-found' }])
  })

  it('bundle required ausente lança ProfileError (política strict)', () => {
    const { profileDir, homeDir } = makeProfile()
    // torna o bundle base inacessível
    rmSync(join(profileDir, 'bundles', 'base'), { recursive: true, force: true })
    expect(() => composeProfile({ profileDir, homeDir })).toThrow(ProfileError)

    // lenient: salta e reporta (inclui o optional que já falhava)
    const result = composeProfile({ profileDir, homeDir, onBundleError: 'lenient' })
    expect(result.skipped).toContainEqual({ bundle: './bundles/base', reason: 'not-found' })
    expect(result.skipped).toContainEqual({ bundle: './bundles/optional', reason: 'not-found' })
  })

  it('overlay inexistente é erro (não é opcional)', () => {
    const { profileDir, homeDir } = makeProfile()
    expect(() => composeProfile({ profileDir, homeDir, overlays: [join(profileDir, 'nope.yml')] })).toThrow(
      /overlay patch not found/,
    )
  })

  it('directório de perfil inexistente é erro claro', () => {
    expect(() => composeProfile({ profileDir: join(tempDir('dsh-missing-'), 'nope') })).toThrow(ProfileError)
  })

  it('manifesto inválido é ProfileError', () => {
    const profileDir = tempDir('dsh-bad-manifest-')
    writeFileSync(join(profileDir, 'package.json'), '{ nao é json')
    expect(() => composeProfile({ profileDir })).toThrow(/invalid package.json/)
  })

  it('!!js é avaliado em todas as camadas', () => {
    const root = tempDir('dsh-js-')
    const profileDir = join(root, 'profile')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, PATCH_FILE), 'row:\n  plugin: mod\n  config:\n    v: !!js 2 + 2\n')
    const result = composeProfile({ profileDir, homeDir: join(root, 'empty-home') })
    expect(result.rows[0]?.config).toEqual({ v: 4 })
  })
})

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

describe('defaultResolveBundle', () => {
  it('resolve caminho relativo (directório ou ficheiro .yml)', () => {
    const dir = tempDir('dsh-bundle-')
    mkdirSync(join(dir, 'bundles', 'base'), { recursive: true })
    writeFileSync(join(dir, 'bundles', 'base', PATCH_FILE), 'a: p\n')
    writeFileSync(join(dir, 'solo.yml'), 'b: q\n')

    expect(defaultResolveBundle('./bundles/base', dir)).toBe(join(dir, 'bundles', 'base', PATCH_FILE))
    expect(defaultResolveBundle('./solo.yml', dir)).toBe(join(dir, 'solo.yml'))
    expect(defaultResolveBundle('./inexistente', dir)).toBeNull()
  })

  it('resolve nome de pacote via caminhada node_modules', () => {
    const dir = tempDir('dsh-nm-')
    const pkgDir = join(dir, 'node_modules', 'fake-bundle')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, PATCH_FILE), 'a: p\n')
    expect(defaultResolveBundle('fake-bundle', join(dir, 'deeper', 'deeper2'))).toBe(join(pkgDir, PATCH_FILE))
  })

  it('pacote existente sem patch devolve null', () => {
    const dir = tempDir('dsh-nm-nopatch-')
    const pkgDir = join(dir, 'node_modules', 'no-patch')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'no-patch' }))
    expect(defaultResolveBundle('no-patch', dir)).toBeNull()
  })
})

describe('readPatchFile / defaultProfileDir / profileExists', () => {
  it('readPatchFile lê um patch ou devolve null', () => {
    const dir = tempDir('dsh-read-')
    const file = join(dir, PATCH_FILE)
    writeFileSync(file, 'row: mod\n')
    expect(readPatchFile(file)).toEqual([{ id: 'row', plugin: 'mod' }])
    expect(readPatchFile(join(dir, 'nope.yml'))).toBeNull()
  })

  it('defaultProfileDir/profileExists usam o home', () => {
    const home = tempDir('dsh-home-')
    const dir = defaultProfileDir('desktop', home)
    expect(dir).toBe(join(home, 'profiles', 'desktop'))
    expect(profileExists('desktop', home)).toBe(false)
    mkdirSync(dir, { recursive: true })
    expect(profileExists('desktop', home)).toBe(true)
  })
})

/** Sanity-check: os fixtures estáticos continuam a existir (usados por app-boot). */
describe('fixtures', () => {
  it('directório de fixtures do profile-boot existe', () => {
    expect(fixturesDir).toContain('profile-boot')
  })
})
