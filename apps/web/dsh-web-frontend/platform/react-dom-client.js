// ---------------------------------------------------------------------------
// Módulo de plataforma: `react-dom/client`.
//
// No UMD, `createRoot`/`hydrateRoot` vivem no próprio `window.ReactDOM` — o
// ficheiro `react-dom/client` não existe como tal. Este shim expõe-os sob o
// import specifier que o compilador emite (`jsx: react-jsx` + ReactDOM 18).
// ---------------------------------------------------------------------------

const { createRoot, hydrateRoot } = window.ReactDOM

export { createRoot, hydrateRoot }
