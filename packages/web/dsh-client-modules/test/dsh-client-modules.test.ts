import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  BOOT_PATH,
  createClientModuleRoutes,
  derivePluginId,
  renderBootScript,
  renderComboModule,
  scanClientPlugins,
  toClientPlugin,
  type BootManifest,
  type ClientModuleRoutes,
  type ScannedClient,
} from '@open-harness/dsh-client-modules'
import {
  ClientModuleError,
  ModuleLoader,
  PLATFORM_MODULES,
  createLoader,
  readBootManifest,
} from '@open-harness/dsh-client-modules/browser'
import type { WebServer } from '@open-harness/dsh-host-webserver'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const dirs: string[] = []
const servers: WebServer[] = []

afterAll(() => {
  for (const server of servers) void server.close()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

/** Directório de pacote falso, com `package.json` (e opcionalmente o `entry`). */
function fakePackage(name: string, dsh?: unknown, files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cm-'))
  dirs.push(dir)
  const pkg: Record<string, unknown> = { name, version: '0.0.0', type: 'module' }
  if (dsh !== undefined) pkg['dsh'] = dsh
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg), 'utf8')
  for (const [file, body] of Object.entries(files)) {
    const target = join(dir, file)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, body, 'utf8')
  }
  return dir
}

/** Servidor real para as rotas, com token fixo. */
async function serve(routes: ClientModuleRoutes): Promise<WebServer> {
  const { WebServer } = await import('@open-harness/dsh-host-webserver')
  const server = await WebServer.listen({ host: '127.0.0.1', port: 0, token: 'tok-cm' })
  servers.push(server)
  server.use(BOOT_PATH, routes.boot)
  server.use('/plugins/', routes.modules)
  return server
}

interface RawResponse {
  status: number
  body: string
  contentType: string | undefined
}

function get(server: WebServer, path: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: server.host, port: server.port, path, method: 'GET', headers: { authorization: 'Bearer tok-cm' } },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            contentType: res.headers['content-type'],
          }),
        )
      },
    )
    req.on('error', reject)
    req.end()
  })
}

// ---------------------------------------------------------------------------
// Scan (metade Node)
// ---------------------------------------------------------------------------

describe('scanClientPlugins', () => {
  it('deriva o id curto do nome do pacote', () => {
    expect(derivePluginId('@open-harness/dsh-client-ui-chat')).toBe('ui-chat')
    expect(derivePluginId('@open-harness/dsh-ui-sidebar')).toBe('ui-sidebar')
    expect(derivePluginId('dsh-client-ui-tool')).toBe('ui-tool')
  })

  it('descobre só os pacotes com dsh.client e ordena por order/id', () => {
    const withField = fakePackage('@open-harness/dsh-client-ui-chat', {
      client: { entry: './dist/client.js', slots: ['chat', 'composer'], order: 10 },
    })
    const other = fakePackage('@open-harness/dsh-client-ui-zeta', {
      client: { entry: './dist/client.js', order: 10 },
    })
    const without = fakePackage('@open-harness/dsh-agent', { server: { entry: './dist/index.js' } })
    const noDsh = fakePackage('@open-harness/home-paths')

    const found = scanClientPlugins([withField, other, without, noDsh])
    expect(found.map((p) => p.id)).toEqual(['ui-chat', 'ui-zeta'])
    expect(found[0]?.slots).toEqual(['chat', 'composer'])
    expect(found[0]?.order).toBe(10)
  })

  it('usa o id explícito, a ordem por omissão e entradas inexistente sem descartar', () => {
    const dir = fakePackage('@open-harness/dsh-client-ui-theme', {
      client: { id: 'tema', entry: './out/browser.js' },
    })
    const [plugin] = scanClientPlugins([dir])
    expect(plugin?.id).toBe('tema')
    expect(plugin?.order).toBe(100)
    // O `entry` não existe no disco, mas o plugin continua no boot (o host
    // pode servir um dist construído noutro passo).
    expect(plugin?.entry).toBe('browser.js')
    expect(plugin?.dir).toBe(join(dir, 'out'))
  })

  it('converte para o manifesto com URL de entrada sob o prefixo', () => {
    const scanned: ScannedClient = {
      id: 'ui-chat',
      packageName: '@open-harness/dsh-client-ui-chat',
      dir: '/tmp/x/dist',
      entry: 'client.js',
      slots: ['chat'],
      order: 10,
    }
    expect(toClientPlugin(scanned)).toEqual({
      id: 'ui-chat',
      packageName: '@open-harness/dsh-client-ui-chat',
      entry: '/plugins/ui-chat/client.js',
      slots: ['chat'],
      order: 10,
    })
  })
})

// ---------------------------------------------------------------------------
// Boot + combos
// ---------------------------------------------------------------------------

describe('manifesto e combos', () => {
  it('renderiza o boot como script que atribui o global', () => {
    const manifest: BootManifest = { version: 1, plugins: [], platform: {}, combos: [] }
    const script = renderBootScript(manifest)
    expect(script.startsWith('window.__DSH_BOOT__ = ')).toBe(true)
    expect(JSON.parse(script.slice('window.__DSH_BOOT__ = '.length).replace(/;\n$/, ''))).toEqual(manifest)
  })

  it('gera um combo que importa as entradas pela ordem', () => {
    const body = renderComboModule(
      { name: 'default', url: '/plugins/__combo__/default.js', plugins: ['ui-theme', 'falta'] },
      new Map([['ui-theme', '/plugins/ui-theme/client.js']]),
    )
    expect(body).toContain('import "/plugins/ui-theme/client.js";')
    expect(body).toContain('falta: entrada ausente')
  })

  it('não gera combo quando não há plugins', () => {
    const { manifest } = createClientModuleRoutes({ plugins: [] })
    expect(manifest.combos).toEqual([])
  })

  it('monta o manifesto com plugins ordenados, plataforma e combo', () => {
    const { manifest } = createClientModuleRoutes({
      plugins: [
        { id: 'ui-b', packageName: 'b', dir: '/b', entry: 'client.js', slots: [], order: 20 },
        { id: 'ui-a', packageName: 'a', dir: '/a', entry: 'client.js', slots: ['x'], order: 10 },
      ],
      platform: { react: '/platform/react.js' },
    })
    expect(manifest.version).toBe(1)
    expect(manifest.plugins.map((p) => p.id)).toEqual(['ui-a', 'ui-b'])
    expect(manifest.platform).toEqual({ react: '/platform/react.js' })
    expect(manifest.combos).toEqual([
      { name: 'default', url: '/plugins/__combo__/default.js', plugins: ['ui-a', 'ui-b'] },
    ])
  })
})

// ---------------------------------------------------------------------------
// Rotas HTTP
// ---------------------------------------------------------------------------

describe('rotas /plugins e /__dsh_boot__', () => {
  it('serve o boot, a entrada, o source map e o combo; e recusa fora do disco', async () => {
    const dir = fakePackage('@open-harness/dsh-client-ui-chat', { client: { entry: './dist/client.js' } }, {
      'dist/client.js': 'export const x = 1\n',
      'dist/client.js.map': '{"version":3,"sources":["../src/client.ts"],"mappings":""}',
      'dist/slots.js': 'export const s = 1\n',
    })
    const routes = createClientModuleRoutes({ plugins: scanClientPlugins([dir]) })
    const server = await serve(routes)

    const boot = await get(server, BOOT_PATH)
    expect(boot.status).toBe(200)
    expect(boot.contentType).toContain('text/javascript')
    const manifest = JSON.parse(boot.body.slice('window.__DSH_BOOT__ = '.length).replace(/;\n$/, '')) as BootManifest
    expect(manifest.plugins[0]?.entry).toBe('/plugins/ui-chat/client.js')

    const entry = await get(server, '/plugins/ui-chat/client.js')
    expect(entry.status).toBe(200)
    expect(entry.body).toBe('export const x = 1\n')

    // Imports relativos e source maps resolvem na mesma pasta.
    const sub = await get(server, '/plugins/ui-chat/slots.js')
    expect(sub.status).toBe(200)
    const map = await get(server, '/plugins/ui-chat/client.js.map')
    expect(map.status).toBe(200)
    expect(map.contentType).toContain('application/json')

    const combo = await get(server, '/plugins/__combo__/default.js')
    expect(combo.status).toBe(200)
    expect(combo.body).toContain('import "/plugins/ui-chat/client.js";')

    // Fora do disco: recusa, nunca ficheiros da máquina. O `..` chega cru ao
    // `serveStatic`, que responde 400 (caminho inválido); id desconhecido 404.
    expect((await get(server, '/plugins/ui-chat/../../package.json')).status).toBe(400)
    expect((await get(server, '/plugins/desconhecido/client.js')).status).toBe(404)
    expect((await get(server, '/plugins/__combo__/outro.js')).status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Loader (metade browser)
// ---------------------------------------------------------------------------

describe('ModuleLoader', () => {
  const manifest: BootManifest = {
    version: 1,
    platform: { react: '/platform/react.js' },
    plugins: [
      { id: 'ui-theme', packageName: 'a', entry: '/plugins/ui-theme/client.js', slots: [], order: 10 },
      { id: 'ui-chat', packageName: 'b', entry: '/plugins/ui-chat/client.js', slots: ['chat'], order: 20 },
    ],
    combos: [{ name: 'default', url: '/plugins/__combo__/default.js', plugins: ['ui-theme', 'ui-chat'] }],
  }

  it('expõe a tabela de módulos de plataforma', () => {
    expect(PLATFORM_MODULES).toContain('react')
    expect(PLATFORM_MODULES).toContain('react-dom')
    expect(PLATFORM_MODULES).toContain('@open-harness/cordis')
  })

  it('lê o manifesto do global e valida a forma', () => {
    expect(readBootManifest({ __DSH_BOOT__: manifest })).toEqual(manifest)
    expect(readBootManifest({})).toBeNull()
    expect(readBootManifest({ __DSH_BOOT__: { version: 2 } as never })).toBeNull()
  })

  it('lança um erro claro quando não há manifesto', () => {
    expect(() => new ModuleLoader({ manifest: undefined as never, head: null })).toThrow(/__DSH_BOOT__/)
  })

  it('carrega plugins de forma lazy, em ordem e uma só vez cada', async () => {
    const calls: string[] = []
    const loader = new ModuleLoader({
      manifest,
      head: null,
      importer: async (url: string) => {
        calls.push(url)
        return { url }
      },
    })
    // Lazy: nada importado até agora.
    expect(calls).toEqual([])
    expect(loader.plugins().map((p) => p.id)).toEqual(['ui-theme', 'ui-chat'])

    const all = await loader.loadAll()
    expect(calls).toEqual(['/plugins/ui-theme/client.js', '/plugins/ui-chat/client.js'])
    expect(all.get('ui-chat')).toEqual({ url: '/plugins/ui-chat/client.js' })
    expect(loader.loadedPlugins()).toEqual(['ui-theme', 'ui-chat'])

    // Segunda chamada não volta a importar (cache de promessas).
    await loader.loadPlugin('ui-theme')
    expect(calls).toHaveLength(2)
  })

  it('partilha a promessa entre chamadas paralelas do mesmo plugin', async () => {
    let invocations = 0
    const loader = new ModuleLoader({
      manifest,
      head: null,
      importer: async () => {
        invocations += 1
        await new Promise((r) => setTimeout(r, 5))
        return { ok: true }
      },
    })
    await Promise.all([loader.loadPlugin('ui-chat'), loader.loadPlugin('ui-chat'), loader.loadPlugin('ui-chat')])
    expect(invocations).toBe(1)
  })

  it('reporta o plugin de origem em erros e não guarda a falha', async () => {
    let attempt = 0
    const loader = new ModuleLoader({
      manifest,
      head: null,
      importer: async () => {
        attempt += 1
        if (attempt === 1) throw new Error(' rede ')
        return { ok: true }
      },
    })
    const failure: unknown = await loader.loadPlugin('ui-chat').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ClientModuleError)
    // O erro diz qual o plugin — essencial quando vários carregam em paralelo.
    expect((failure as ClientModuleError).pluginId).toBe('ui-chat')
    expect(String(failure)).toContain('ui-chat')
    // A falha não fica em cache: a nova tentativa importa de novo.
    await expect(loader.loadPlugin('ui-chat')).resolves.toEqual({ ok: true })
    expect(attempt).toBe(2)
  })

  it('recusa plugins desconhecidos', async () => {
    const loader = new ModuleLoader({ manifest, head: null, importer: async () => ({}) })
    await expect(loader.loadPlugin('ui-nada')).rejects.toThrow(/desconhecido/)
  })

  it('usa o combo quando existe, e cai para loadAll quando não', async () => {
    const calls: string[] = []
    const loader = new ModuleLoader({
      manifest,
      head: null,
      importer: async (url: string) => {
        calls.push(url)
        return { url }
      },
    })
    const viaCombo = await loader.loadCombo()
    expect(calls).toContain('/plugins/__combo__/default.js')
    expect(viaCombo.size).toBe(2)

    const semCombo = new ModuleLoader({
      manifest: { ...manifest, combos: [] },
      head: null,
      importer: async (url: string) => ({ url }),
    })
    const modules = await semCombo.loadCombo()
    expect(modules.size).toBe(2)
  })

  it('injecta os módulos de plataforma no import map (uma vez)', async () => {
    const nodes: Array<{ type?: string; textContent?: string }> = []
    const loader = new ModuleLoader({
      manifest,
      importer: async () => ({}),
      head: { appendChild: (node: unknown) => nodes.push(node as { type?: string; textContent?: string }) },
    })
    await loader.loadAll()
    loader.installPlatformMap()
    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.type).toBe('importmap')
    expect(JSON.parse(nodes[0]?.textContent ?? '{}')).toEqual({ imports: { react: '/platform/react.js' } })
  })

  it('createLoader lê o manifesto global', () => {
    const scope = { __DSH_BOOT__: manifest }
    const loader = createLoader({ manifest: readBootManifest(scope) ?? undefined, head: null })
    expect(loader.manifest.plugins).toHaveLength(2)
  })
})
