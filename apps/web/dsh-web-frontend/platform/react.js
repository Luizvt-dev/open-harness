// ---------------------------------------------------------------------------
// Módulo de plataforma: `react`.
//
// O React 18 só distribui CJS/UMD — não há ESM de navegador. O shell carrega
// o UMD por uma tag clássica (que define `window.React`) e este shim expõe o
// mesmo objecto como módulo ES, com as named exports que o compilador
// (`jsx: react-jsx`) espera encontrar em `react`.
//
// Um só React para o shell e para todos os plugins `ui-*`: é isso que a
// tabela `PLATFORM_MODULES` garante, e é por isso que nada disto é embutido
// num bundle.
//
// A lista abaixo é a API pública do React 18 — as hooks e APIs do React 19
// (`use`, `useOptimistic`, …) não existem na versão servida.
// ---------------------------------------------------------------------------

const React = window.React

export default React
export const {
  Children,
  Component,
  Fragment,
  PureComponent,
  StrictMode,
  Suspense,
  cloneElement,
  createContext,
  createElement,
  createRef,
  forwardRef,
  isValidElement,
  lazy,
  memo,
  useCallback,
  useContext,
  useDebugValue,
  useDeferredValue,
  useEffect,
  useId,
  useImperativeHandle,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
  version,
} = React
