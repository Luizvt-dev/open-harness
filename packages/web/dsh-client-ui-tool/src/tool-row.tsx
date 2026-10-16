// ---------------------------------------------------------------------------
// Linha de tool — slot `chat.item.tool`.
//
// É uma reimplementação fiel da `ToolRow` do shell (`<details>` com os
// mesmos estados e a mesma contagem de duração — durante um turno o ecrã não
// pode saltitar) acrescentando uma só coisa: copiar a saída. É aquilo que se
// faz com o output de um tool quase sempre que ele devolve algo útil.
// ---------------------------------------------------------------------------

import type { ReactNode } from 'react'
import { CopyButton, type Message } from '@open-harness/dsh-web-frontend'

/** Linha de tool: estado, saída e copiar a saída. */
export function ToolRowItem(props: { message: Message }): ReactNode {
  if (props.message.kind !== 'tool') return null
  const tool = props.message
  const state = tool.ok === undefined ? 'a correr…' : tool.ok ? 'ok' : 'erro'
  const className =
    `ferramenta${tool.ok === undefined ? ' ferramenta--running' : tool.ok ? ' ferramenta--ok' : ' ferramenta--fail'}`

  return (
    <details className={className}>
      <summary className="ferramenta-head">
        <span className="ferramenta-name">{tool.name}</span>
        <span className="ferramenta-state">
          {tool.ok === undefined || tool.durationMs === undefined
            ? state
            : `${tool.ok ? 'ok' : 'erro'} · ${tool.durationMs} ms`}
        </span>
      </summary>
      {tool.output ? <pre className="ferramenta-output">{tool.output}</pre> : null}
      {tool.output ? (
        // A linha de acções é a ÚNICA diferença face ao shell. O `padding` é
        // inline porque aqui os filhos do `<details>` encostam na borda — o
        // `msg-actions` do shell vive dentro de uma bolha, que já tem `padding`.
        <div className="msg-actions" style={{ padding: '4px 12px', marginTop: 0 }}>
          <CopyButton className="msg-copy" label="copiar saída" text={tool.output} />
        </div>
      ) : null}
    </details>
  )
}
