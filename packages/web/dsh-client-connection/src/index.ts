import { HttpClient } from './http.js'
import { MuxClient } from './mux.js'
import type { ClientOptions, RemoteClient } from './types.js'

// Público do dsh-client-connection: o cliente do navegador para o host —
// RPC multiplexado sobre um WebSocket, com reconexão e geração, e um caminho
// fetch/SSE para ambientes sem WebSocket.
export * from './types.js'
export { MuxClient } from './mux.js'
export { HttpClient } from './http.js'

/**
 * Cria o cliente certo para o transporte pedido.
 *
 * Por omissão escolhe o mux: um único WebSocket autenticado serve chamadas,
 * streams, heartbeat e uplink — é o que o plano do dsh chama Typert Remote.
 */
export function createClient(options: ClientOptions): RemoteClient {
  return options.transport === 'http' ? new HttpClient(options) : new MuxClient(options)
}
