// ---------------------------------------------------------------------------
// Topbar: título e contexto da sessão à esquerda, estatísticas do turno à
// direita, com dois slots aditivos por volta do conteúdo.
// ---------------------------------------------------------------------------

import type { ReactNode } from 'react'
import { Slot } from '@open-harness/dsh-client-ui-slots'
import { SLOTS } from './slots.js'

export interface TopbarProps {
  title: string
  context: string
  stats: string
}

export function Topbar(props: TopbarProps): ReactNode {
  return (
    <header className="topbar">
      <Slot name={SLOTS.topbarBefore} />
      <div className="topbar-text">
        <div className="title">{props.title || 'sem sessão'}</div>
        <div className="context">{props.context}</div>
      </div>
      <div className="stats">{props.stats}</div>
      <Slot name={SLOTS.topbarAfter} />
    </header>
  )
}
