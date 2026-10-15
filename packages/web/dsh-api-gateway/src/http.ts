import type { IncomingMessage, ServerResponse } from 'node:http'
import { RemoteError } from './errors.js'
import type { Gateway } from './gateway.js'
import { PROTOCOL_VERSION } from './types.js'

// ---------------------------------------------------------------------------
// Caminho HTTP do RPC
//
// Nem tudo tem de falar WebSocket: o plano do dsh prevê um cliente fetch/SSE
// no navegador, e é também o caminho mais fácil para scripts, curl e testes.
// Mesmo gateway, mesmo protocolo de erro, transporte diferente.
// ---------------------------------------------------------------------------

/** Handler HTTP (mesmo contrato do `node:http` / do servidor web). */
export type HttpRequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => void | Promise<void>

export interface HttpRpcOptions {
  /** Teto de corpo do pedido, em bytes. Default 4 MiB. */
  bodyLimit?: number
}

export interface HttpRpc {
  /** `POST {method, params}` → `{result}` ou `{error}`. */
  unary: HttpRequestHandler
  /** `POST {method, params}` → SSE com `event: data`… e `event: end`. */
  stream: HttpRequestHandler
}

/** Escreve JSON com headers por omissão do host. */
function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

async function readJsonBody(
  req: IncomingMessage,
  limitBytes: number,
): Promise<{ method: string; params: unknown }> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk as Buffer)
    size += buffer.length
    if (size > limitBytes) throw new RemoteError('invalid_params', 'request body too large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(text || '{}')
  } catch {
    throw new RemoteError('invalid_params', 'request body is not JSON')
  }
  const body = (parsed ?? {}) as { method?: unknown; params?: unknown }
  if (typeof body.method !== 'string' || !body.method) {
    throw new RemoteError('invalid_params', 'body must include a "method" string')
  }
  return { method: body.method, params: body.params ?? null }
}

/**
 * Cria os handlers HTTP do gateway.
 *
 * Ficam montados no servidor web:
 *
 *   server.use('/api/remote', rpc.unary)       // POST unary
 *   server.use('/api/remote/stream', rpc.stream) // POST → SSE
 */
export function createHttpRpc(gateway: Gateway, options: HttpRpcOptions = {}): HttpRpc {
  const bodyLimit = options.bodyLimit ?? 4 * 1024 * 1024

  const unary: HttpRequestHandler = async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: { code: 'invalid_params', message: 'use POST' } })
      return
    }
    try {
      const { method, params } = await readJsonBody(req, bodyLimit)
      const result = await gateway.call(method, params, {
        method,
        // O caminho HTTP não tem cancelamento: o sinal fica aberto.
        signal: new AbortController().signal,
        connection: { id: 'http', send: () => undefined },
      })
      sendJson(res, 200, { v: PROTOCOL_VERSION, result: result ?? null })
    } catch (error) {
      sendJson(res, 400, { v: PROTOCOL_VERSION, error: RemoteError.from(error).toShape() })
    }
  }

  const stream: HttpRequestHandler = async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: { code: 'invalid_params', message: 'use POST' } })
      return
    }
    const controller = new AbortController()
    // A ligação desapareceu sem a resposta terminar (navegador fechado, curl
    // interrompido): aborta o handler para o trabalho não continuar em vão.
    // Usamos o `close` da *resposta* — o `close` do pedido dispara apenas por
    // ter lido o corpo, o que abortaria logo o stream.
    res.on('close', () => {
      if (!res.writableEnded) controller.abort()
    })

    try {
      const body = await readJsonBody(req, bodyLimit)

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        // Nginx e afins não devem bufferizar o stream.
        'x-accel-buffering': 'no',
        'x-content-type-options': 'nosniff',
      })
      const emit = (event: string, data: unknown): void => {
        if (res.writableEnded || controller.signal.aborted) return
        res.write(`event: ${event}\ndata: ${JSON.stringify(data ?? null)}\n\n`)
      }

      emit('open', { v: PROTOCOL_VERSION, method: body.method })
      for await (const data of gateway.stream(body.method, body.params, {
        method: body.method,
        signal: controller.signal,
        connection: { id: 'http', send: (channel, payload) => emit(channel, payload) },
      })) {
        emit('data', data)
      }
      emit('end', {})
      res.end()
    } catch (error) {
      const shape = RemoteError.from(error).toShape()
      if (!res.headersSent) {
        sendJson(res, 400, { v: PROTOCOL_VERSION, error: shape })
      } else if (!res.writableEnded) {
        res.write(`event: error\ndata: ${JSON.stringify(shape)}\n\n`)
        res.end()
      }
    }
  }

  return { unary, stream }
}
