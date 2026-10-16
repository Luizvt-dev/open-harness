// ---------------------------------------------------------------------------
// Comutador de tema, para o slot `sidebar.after`.
//
// Fica em texto simples (nome + valor) em vez de um ícone: a sidebar usa
// cores por variável, e um ícone seria a única coisa com cor fixa — o estado
// tem de ser legível em qualquer tema.
// ---------------------------------------------------------------------------

import { useState, type ReactNode } from 'react'
import { applyTheme, readTheme, writeTheme, type Theme } from './theme.js'

/** Rótulo legível de um tema. */
const LABELS: Record<Theme, string> = { dark: 'escuro', light: 'claro' }

/** Próximo tema da alternância. */
export function nextTheme(theme: Theme): Theme {
  return theme === 'dark' ? 'light' : 'dark'
}

/** Botão que alterna entre o tema escuro (default) e o claro. */
export function ThemeToggle(): ReactNode {
  const [theme, setTheme] = useState<Theme>(() => readTheme())

  return (
    <button
      type="button"
      className="ui-theme"
      title="Alternar tema da interface"
      onClick={() => {
        const next = nextTheme(theme)
        setTheme(next)
        writeTheme(next)
        applyTheme(next)
      }}
    >
      <span>Tema</span>
      <span className="ui-theme-value">{LABELS[theme]}</span>
    </button>
  )
}
