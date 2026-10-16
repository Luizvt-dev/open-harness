// ---------------------------------------------------------------------------
// Módulo de plataforma: `react/jsx-runtime`.
//
// `jsx: react-jsx` faz o compilador emitir `import { jsx, jsxs } from
// 'react/jsx-runtime'`. O runtime real do React vive em CJS, por isso este
// shim reimplementa a superfície mínima sobre `React.createElement`, que é
// exactamente o que o runtime faz por baixo:
//
//   - `key` em `config` ou no 3.º argumento é extraído e tratado pelo próprio
//     `createElement` (ele lê `config.key` e remove-o dos props);
//   - `children` dentro de `config` também é passado adiante pelo
//     `createElement`, por isso `jsx(type, { children })` funciona como
//     `jsx(type, undefined, children)` não seria preciso.
//
// `jsxs` só difere de `jsx` numa optimização de filhos estáticos — o
// resultado renderizado é idêntico.
// ---------------------------------------------------------------------------

const React = window.React

export const Fragment = React.Fragment

export function jsx(type, config, maybeKey) {
  const props = { ...(config ?? {}) }
  if (maybeKey !== undefined) props.key = maybeKey
  return React.createElement(type, props)
}

export const jsxs = jsx
