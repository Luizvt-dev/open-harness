// Público do dsh-api-gateway: RPC tipado do host — unary + streams
// multiplexados sobre WebSocket, heartbeat, uplink, caminho HTTP/SSE e
// `RemoteError` como único tipo de erro que cruza o transporte.
export * from './errors.js'
export * from './types.js'
export * from './gateway.js'
export * from './mux.js'
export * from './http.js'
