import { sendJson, serveStatic } from '@open-harness/dsh-host-webserver'
import type { RequestHandler } from '@open-harness/dsh-host-webserver'
import { toClientPlugin, type ScannedClient } from './scan.js'
import type { BootManifest, ComboManifest, PlatformModules } from './types.js'

// ---------------------------------------------------------------------------
// Metade Node: serviço dos módulos de UI.
//
// Três caminhos, um contrato:
//
//   /__dsh_boot__.js          atribui `window.__DSH_BOOT__` (manifesto)
//   /plugins/<id>/<ficheiro>  serve a pasta do `entry` de cada plugin
//   /plugins/__combo__/<a>+<b>.js  um só import que puxa vários plugins
//
// O host autentica antes de qualquer rota; aqui só se serve ficheiros dentro
// das pastas descobertas — o `serveStatic` recusa travessia de directórios.
// ---------------------------------------------------------------------------

/** Prefixo dos plugins. Os combos ficam em `/plugins/__combo__/` (não é id). */
export const PLUGINS_PREFIX = '/plugins/'

/** Nome do subdirectório dos combos (reservado: não pode ser id de plugin). */
const COMBO_DIR = '__combo__'

/**
 * Caminho de URL sem normalizar.
 *
 * `new URL().pathname` colapsa `..` — o que faria `/plugins/a/../b` parecer
 * `/plugins/b` e esconderia a travessia do `serveStatic`. Aqui só se corta a
 * query/hash, tal como o `rawPathname` do servidor.
 */
export function rawPathOf(url: string): string {
  return url.split(/[?#]/, 1)[0] ?? '/'
}

/** Decodifica um segmento de caminho, ou devolve-o como está se for inválido. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/** Caminho do script de boot que monta `window.__DSH_BOOT__`. */
export const BOOT_PATH = '/__dsh_boot__.js'

/** Opções de arranque das rotas de módulos do cliente. */
export interface ClientModuleRoutesOptions {
  /** Plugins descobertos (`scanClientPlugins`). */
  plugins: ScannedClient[]
  /** Módulos partilhados (React/Cordis/base) para a tabela do boot. */
  platform?: PlatformModules
  /** Prefixo dos plugins. Default `/plugins/`. */
  prefix?: string
  /** Nome do combo que junta todos os plugins. Default `default`. */
  comboName?: string
}

/** O que as rotas expõem — para os testes e para o host inspeccionarem. */
export interface ClientModuleRoutes {
  /** Manifesto que vai para `window.__DSH_BOOT__`. */
  manifest: BootManifest
  /** `GET /__dsh_boot__.js`. */
  boot: RequestHandler
  /** `GET /plugins/…` (entradas, submódulos, source maps e combos). */
  modules: RequestHandler
}

/** Serializa o manifesto como script que atribui o global. */
export function renderBootScript(manifest: BootManifest): string {
  return `window.__DSH_BOOT__ = ${JSON.stringify(manifest)};\n`
}

/**
 * Constrói o módulo combo: um ficheiro que importa as entradas dos plugins
 * pela ordem de carregamento.
 *
 * Não é um bundle — é um grafo de imports que o navegador resolve sozinho.
 * O ganho é uma só ida ao servidor (e um só ponto de revalidação) para a
 * maioria dos arranques; o cache HTTP faz o resto.
 */
export function renderComboModule(combo: ComboManifest, plugins: Map<string, string>): string {
  const lines = combo.plugins.map((id) => {
    const entry = plugins.get(id)
    return entry ? `import ${JSON.stringify(entry)};` : `/* ${id}: entrada ausente, ignorada */`
  })
  return `// combo ${combo.name}: gerado pelo host\n${lines.join('\n')}\n`
}

/**
 * Cria as rotas dos módulos do cliente.
 *
 * O `modules` handler devolve `false` (deixa passar) quando o caminho não é
 * de plugins — assim o host pode encadear outros handlers depois dele.
 */
export function createClientModuleRoutes(options: ClientModuleRoutesOptions): ClientModuleRoutes {
  const prefix = options.prefix ?? PLUGINS_PREFIX
  const base = prefix.endsWith('/') ? prefix : `${prefix}/`
  const comboName = options.comboName ?? 'default'
  const scanned = [...options.plugins].sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id))
  const clients = scanned.map((s) => toClientPlugin(s, base))
  const byId = new Map(scanned.map((s) => [s.id, s]))

  const combos: ComboManifest[] = []
  if (clients.length > 0) {
    combos.push({
      name: comboName,
      url: `${base}${COMBO_DIR}/${comboName}.js`,
      plugins: clients.map((c) => c.id),
    })
  }

  const manifest: BootManifest = {
    version: 1,
    plugins: clients,
    platform: { ...(options.platform ?? {}) },
    combos,
  }

  const boot: RequestHandler = (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: { code: 'method_not_allowed', message: 'GET only' } })
      return
    }
    const body = renderBootScript(manifest)
    res.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'content-length': String(Buffer.byteLength(body)),
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    })
    res.end(body)
  }

  const modules: RequestHandler = async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: { code: 'method_not_allowed', message: 'GET only' } })
      return
    }
    // Caminho cru: `..` tem de chegar ao `serveStatic`, que o recusa.
    const pathname = rawPathOf(req.url ?? '/')
    if (!pathname.startsWith(base)) {
      sendJson(res, 404, { error: { code: 'not_found', message: `sem módulo para ${pathname}` } })
      return
    }
    const rest = pathname.slice(base.length)
    const slash = rest.indexOf('/')
    const head = slash > 0 ? decodeSegment(rest.slice(0, slash)) : ''
    const file = slash > 0 ? rest.slice(slash + 1) : ''

    // Combo: `/plugins/__combo__/<nome>.js` → módulo que importa tudo.
    if (head === COMBO_DIR) {
      const combo = combos.find((c) => `${c.name}.js` === file)
      if (!combo) {
        sendJson(res, 404, { error: { code: 'not_found', message: `sem combo ${file}` } })
        return
      }
      const entries = new Map(clients.map((c) => [c.id, c.entry]))
      const body = renderComboModule(combo, entries)
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'content-length': String(Buffer.byteLength(body)),
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
      })
      res.end(body)
      return
    }

    const plugin = head ? byId.get(head) : undefined
    if (!plugin || !file) {
      sendJson(res, 404, { error: { code: 'not_found', message: `sem módulo para ${pathname}` } })
      return
    }
    // Serve a pasta do `entry`: entrada, imports relativos e source maps.
    const served = await serveStatic(req, res, file, { root: plugin.dir, compressFrom: 1024 })
    if (!served) {
      sendJson(res, 404, { error: { code: 'not_found', message: `sem ficheiro ${head}/${file}` } })
    }
  }

  return { manifest, boot, modules }
}
