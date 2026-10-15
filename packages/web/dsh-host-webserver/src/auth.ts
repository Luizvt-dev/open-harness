import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

// ---------------------------------------------------------------------------
// Auth por token
//
// O dsh entregava ao shell uma URL com o token de sessão. Aqui aceitamos o
// token de duas formas, porque o navegador não permite definir headers numa
// ligação WebSocket:
//
//   - `Authorization: Bearer <token>`  (fetch, curl, clientes nativos)
//   - `?access_token=<token>`          (URL do browser e handshake WebSocket)
// ---------------------------------------------------------------------------

/** Compara tokens em tempo constante (não vaza o prefixo correcto). */
export function tokenEquals(expected: string, candidate: string): boolean {
  if (!expected) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(candidate)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** Extrai o token candidato do pedido (header ou query). */
export function candidateToken(req: IncomingMessage): string {
  const header = req.headers.authorization
  if (typeof header === 'string') {
    const match = /^bearer\s+(.+)$/i.exec(header.trim())
    if (match) return match[1].trim()
  }
  const url = new URL(req.url ?? '/', 'http://localhost')
  return url.searchParams.get('access_token') ?? ''
}

/** O pedido traz o token correcto? */
export function isAuthorized(req: IncomingMessage, token: string): boolean {
  const candidate = candidateToken(req)
  if (!candidate) return false
  return tokenEquals(token, candidate)
}
