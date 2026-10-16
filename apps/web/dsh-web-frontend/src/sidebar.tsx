// ---------------------------------------------------------------------------
// Sidebar: marca, nova sessão, lista de sessões e rodapé de ligação.
//
// A lista é reordenável por teclado (cada sessão é um `<button>` dentro de um
// `<li>`, como na UI vanilla) e o `onRemove` fica num `<button>` separado para
// que remover não dispare a abertura da sessão — o clique no `li` propagava-se
// e, sem `stopPropagation`, remover uma sessão abria-a primeiro.
// ---------------------------------------------------------------------------

import type { ReactNode } from 'react'
import { Slot } from '@open-harness/dsh-client-ui-slots'
import type { ConnectionState } from './types.js'
import { SLOTS } from './slots.js'
import type { SessionInfo } from './types.js'

/** Mapeia o estado da ligação para o par `dot--*` + texto. */
export function connectionLabel(state: ConnectionState): { className: string; text: string } {
  switch (state) {
    case 'open':
      return { className: 'dot dot--on', text: 'ligado' }
    case 'connecting':
      return { className: 'dot dot--wait', text: 'a ligar…' }
    case 'closed':
      return { className: 'dot dot--off', text: 'desligado' }
  }
}

export interface SidebarProps {
  sessions: SessionInfo[]
  currentId: string | null
  connection: ConnectionState
  hostInfo: string
  onNew: () => void
  onOpen: (session: SessionInfo) => void
  onRemove: (session: SessionInfo) => void
}

export function Sidebar(props: SidebarProps): ReactNode {
  const { className, text } = connectionLabel(props.connection)
  return (
    <aside className="sidebar">
      <Slot name={SLOTS.sidebarBefore} />
      <header className="sidebar-top">
        <span className="brand">Open Harness</span>
        <button className="icon" title="Nova sessão" type="button" onClick={props.onNew}>
          ＋
        </button>
      </header>
      <ul className="sessions">
        {props.sessions.map((session) => {
          const active = session.id === props.currentId
          return (
            <li
              key={session.id}
              className={active ? 'session session--active' : 'session'}
              // `tabIndex` + `keydown`: a linha é clicável mas tem de ser
              // alcançável só com teclado, como na UI vanilla.
              tabIndex={0}
              onClick={() => props.onOpen(session)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') props.onOpen(session)
              }}
            >
              <span className="session-name">{session.title}</span>
              <button
                className="session-remove"
                title="Remover sessão"
                type="button"
                onClick={(event) => {
                  // O clique não pode abrir a sessão antes de a remover: a linha
                  // inteira também é clicável.
                  event.stopPropagation()
                  props.onRemove(session)
                }}
              >
                ×
              </button>
            </li>
          )
        })}
      </ul>
      <Slot name={SLOTS.sidebarAfter} />
      <footer className="sidebar-foot">
        <span className={className}>{text}</span>
        <span className="host-info">{props.hostInfo}</span>
      </footer>
    </aside>
  )
}
