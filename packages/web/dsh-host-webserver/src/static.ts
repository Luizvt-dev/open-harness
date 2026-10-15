import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { brotliCompress, gzip } from 'node:zlib'
import { promisify } from 'node:util'

const gzipAsync = promisify(gzip)
const brotliAsync = promisify(brotliCompress)

// ---------------------------------------------------------------------------
// Servidor estático
//
// Protegido contra path traversal, com ETag/Last-Modified, compressão
// negociada (brotli > gzip) e cache em memória do resultado comprimido.
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
}

/** Tipos que vale a pena comprimir. */
function isCompressible(type: string): boolean {
  return (
    type.startsWith('text/') ||
    type === 'application/json' ||
    type === 'application/manifest+json' ||
    type === 'image/svg+xml' ||
    type === 'application/wasm' ||
    type === 'application/xml'
  )
}

export function contentTypeOf(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Resolve um caminho de URL para dentro do directório raiz.
 *
 * Devolve `null` quando o caminho tenta escapar (traversal) ou é inválido —
 * é a defesa contra `GET /../../etc/passwd`.
 */
export function resolveStaticPath(root: string, urlPath: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    return null
  }
  if (decoded.includes('\0')) return null
  // Normaliza separadores de URL e remove a query/hash já cortados pelo caller.
  const clean = decoded.replace(/\\/g, '/')
  // Um caminho estático legítimo nunca precisa de `..`; recusamos todos.
  if (clean.split('/').some((part) => part === '..')) return null
  const absolute = resolve(root, clean.replace(/^\/+/, ''))
  const base = resolve(root)
  if (absolute !== base && !absolute.startsWith(base + sep)) return null
  return absolute
}

interface CachedEntry {
  mtimeMs: number
  size: number
  /** Buffers por codificação (`identity` = sem compressão). */
  encodings: Map<string, Buffer>
}

const cache = new Map<string, CachedEntry>()
const CACHE_LIMIT = 200

function remember(key: string, entry: CachedEntry): void {
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, entry)
}

/** Escolhe a codificação aceite pelo cliente (brotli > gzip). */
function negotiatedEncoding(req: IncomingMessage): 'br' | 'gzip' | 'identity' {
  const header = String(req.headers['accept-encoding'] ?? '')
  if (/\bbr\b/.test(header)) return 'br'
  if (/\bgzip\b/.test(header)) return 'gzip'
  return 'identity'
}

async function encode(encoding: 'br' | 'gzip', body: Buffer): Promise<Buffer> {
  return encoding === 'br' ? brotliAsync(body) : gzipAsync(body)
}

export interface ServeStaticOptions {
  root: string
  /** Tamanho mínimo (bytes) para comprimir. */
  compressFrom: number
  /** Ficheiros maiores que isto são servidos por stream (sem compressão). */
  streamFrom?: number
}

/**
 * Serve `urlPath` a partir de `root`.
 *
 * Devolve `true` quando respondeu; `false` quando o ficheiro não existe (o
 * chamador decide se faz fallback para `index.html`).
 */
export async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  urlPath: string,
  options: ServeStaticOptions,
): Promise<boolean> {
  const file = resolveStaticPath(options.root, urlPath)
  if (!file) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('bad path')
    return true
  }

  let info
  try {
    info = await stat(file)
  } catch {
    return false
  }
  if (!info.isFile()) return false

  const type = contentTypeOf(file)
  const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`
  const lastModified = new Date(info.mtimeMs).toUTCString()

  const ifNoneMatch = req.headers['if-none-match']
  if (ifNoneMatch && ifNoneMatch === etag) {
    res.writeHead(304, { etag, 'last-modified': lastModified })
    res.end()
    return true
  }

  // Ficheiros grandes: stream sem comprimir (evita bufferizar bundles pesados).
  const streamFrom = options.streamFrom ?? 1024 * 1024
  if (info.size > streamFrom) {
    res.writeHead(200, {
      'content-type': type,
      'content-length': String(info.size),
      etag,
      'last-modified': lastModified,
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    })
    createReadStream(file).pipe(res)
    return true
  }

  const encoding = isCompressible(type) && info.size >= options.compressFrom
    ? negotiatedEncoding(req)
    : 'identity'

  let entry = cache.get(file)
  if (!entry || entry.mtimeMs !== info.mtimeMs) {
    const original = await readFile(file)
    entry = {
      mtimeMs: info.mtimeMs,
      size: info.size,
      encodings: new Map([['identity', original]]),
    }
    remember(file, entry)
  }

  const original = entry.encodings.get('identity') as Buffer
  let payload = original
  if (encoding !== 'identity') {
    payload = entry.encodings.get(encoding) ?? (await encode(encoding, original))
    entry.encodings.set(encoding, payload)
  }

  const headers: Record<string, string> = {
    'content-type': type,
    'content-length': String(payload.length),
    etag,
    'last-modified': lastModified,
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
    vary: 'Accept-Encoding',
  }
  if (encoding !== 'identity') headers['content-encoding'] = encoding

  res.writeHead(200, headers)
  res.end(payload)
  return true
}

/** Limpa o cache de estático (testes). */
export function clearStaticCache(): void {
  cache.clear()
}
