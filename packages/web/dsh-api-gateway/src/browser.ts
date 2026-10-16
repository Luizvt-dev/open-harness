// Entrada **browser** do dsh-api-gateway.
//
// O cliente do navegador só precisa do que viaja no fio: as constantes do
// protocolo (`PROTOCOL_VERSION`, frames) e `RemoteError`. O `index.ts`
// completo re-exporta `mux.js` e `http.js`, que usam `node:crypto` e
// `node:http` — não existem no browser e rebentam o carregamento do módulo.
//
// Este módulo é a ponte: puro, sem builtins, importável como módulo ES via
// import map (ver `apps/dsh/bundles/web/public/index.html`). O lado Node
// continua a usar a entrada `.` — nada muda para quem já o faz.
export * from './types.js'
export * from './errors.js'
