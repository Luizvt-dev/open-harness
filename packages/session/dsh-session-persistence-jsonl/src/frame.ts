import { crc32 } from 'node:zlib'
import { promisify } from 'node:util'
import { zstdCompress, zstdDecompress } from 'node:zlib'

const compress = promisify(zstdCompress)
const decompress = promisify(zstdDecompress)

/**
 * Ficheiro de sessão = cabeçalho JSON (linha 1) + frames (linhas seguintes).
 *
 * Cada frame é `<crc32-hex>$<base64>`; o payload é o JSON do registo, ou o
 * JSON comprimido com Zstd quando `compression === 'zstd'`. O checksum cobre
 * o payload (antes do base64), permitindo detectar e descartar o último frame
 * incompleiro (torn-tail) sem perder os anteriores.
 */
export type Compression = 'none' | 'zstd'

export interface EncodeFrameOptions {
  compression?: Compression
}

function toBase64(buffer: Buffer): string {
  return buffer.toString('base64')
}

function checksum(payload: Buffer): string {
  return (crc32(payload) >>> 0).toString(16).padStart(8, '0')
}

/** Codifica um registo num frame de uma linha. */
export async function encodeFrame(record: unknown, options: EncodeFrameOptions = {}): Promise<string> {
  const compression = options.compression ?? 'zstd'
  const json = Buffer.from(JSON.stringify(record), 'utf8')
  const payload = compression === 'zstd' ? await compress(json) : json
  // O checksum cobre o payload armazenado (já comprimido), para que o decode
  // possa validar antes de descomprimir e detectar bytes corrompidos.
  return `${checksum(payload)}$${toBase64(payload)}`
}

/** Erro de frame (corrupção ou checksum divergente). */
export class FrameError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FrameError'
  }
}

/** Decodifica um frame; lança `FrameError` se o checksum não bater. */
export async function decodeFrame(line: string, options: EncodeFrameOptions = {}): Promise<unknown> {
  const compression = options.compression ?? 'zstd'
  const separator = line.indexOf('$')
  if (separator < 0) throw new FrameError('malformed frame (missing checksum separator)')
  const expected = line.slice(0, separator)
  const payload = Buffer.from(line.slice(separator + 1), 'base64')
  if (checksum(payload) !== expected) throw new FrameError('frame checksum mismatch')
  const json = compression === 'zstd' ? await decompress(payload) : payload
  try {
    return JSON.parse(json.toString('utf8'))
  } catch (error) {
    throw new FrameError(`frame JSON parse error: ${(error as Error).message}`)
  }
}
