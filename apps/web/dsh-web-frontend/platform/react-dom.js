// ---------------------------------------------------------------------------
// Módulo de plataforma: `react-dom`.
//
// Mesmo esquema do `./react.js`: o UMD define `window.ReactDOM` e este shim
// expõe-o como módulo ES. A entrada `./client.js` (abaixo) é a que o shell
// usa para montar a árvore.
// ---------------------------------------------------------------------------

const ReactDOM = window.ReactDOM

export default ReactDOM
export const {
  createPortal,
  createRoot,
  flushSync,
  hydrateRoot,
  render,
  unmountComponentAtNode,
} = ReactDOM
