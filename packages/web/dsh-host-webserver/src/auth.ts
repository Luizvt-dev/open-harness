import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

// ---------------------------------------------------------------------------
// Auth por token
//
// O dsh entregava ao shell uma URL com o token de sessão. Aqui aceitamos o
// token de três formas, porque nem todos os pedidos do navegador deixam
// definir headers:
//
//   - `Authorization: Bearer <token>`  (fetch, curl, clientes nativos)
//   - `?access_token=<token>`          (URL do browser e handshake WebSocket)
//   - cookie `access_token=<token>`    (módulos ES, CSS e imagens — um
//                                       `<script type="module">` não leva
//                                       headers nem query, mas leva cookies)
// ---------------------------------------------------------------------------

/** Compara tokens em tempo constante (não vaza o prefixo correcto). */
export function tokenEquals(expected: string, candidate: string): boolean {
  if (!expected) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(candidate)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** Extrai o token candidato do pedido (header, query ou cookie). */
export function candidateToken(req: IncomingMessage): string {
  const header = req.headers.authorization
  if (typeof header === 'string') {
    const match = /^bearer\s+(.+)$/i.exec(header.trim())
    if (match) return match[1].trim()
  }
  const url = new URL(req.url ?? '/', 'http://localhost')
  const fromQuery = url.searchParams.get('access_token')
  if (fromQuery) return fromQuery
  return cookieToken(req.headers.cookie) ?? ''
}

/**
 * Lê `access_token` do cabeçalho `Cookie`.
 *
 * Devolve `null` (não `''`) quando não há cookie, para distinguir "sem
 * credencial" de "credencial vazia" — o chamador decide se rejeita.
 */
function cookieToken(raw: string | undefined): string | null {
  if (!raw) return null
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() !== 'access_token') continue
    const value = part.slice(eq + 1).trim()
    try {
      return decodeURIComponent(value)
    } catch {
      return value
    }
  }
  return null
}

/** O pedido traz o token correcto? */
export function isAuthorized(req: IncomingMessage, token: string): boolean {
  const candidate = candidateToken(req)
  if (!candidate) return false
  return tokenEquals(token, candidate)
}
