// ---------------------------------------------------------------------------
// Vista da conversa.
//
// Uma linha por entrada: bolha de texto (tu/agente/erro) ou linha de tool.
// Os slots por tipo de item (`chat.item.<kind>`) ficam à frente: se um plugin
// se inscrever, é ele que desenha; sem inscrições, fica a versão embutida.
// ---------------------------------------------------------------------------

import { useEffect, useRef, type ReactNode } from 'react'
import { useSlotEntries, Slot } from '@open-harness/dsh-client-ui-slots'
import type { Conversation, Message } from './conversation.js'
import { SLOTS, itemSlot } from './slots.js'

/** Bolha da conversa: papel + texto. */
export function MessageBubble(props: { role: string; className: string; text: string }): ReactNode {
  return (
    <div className={`msg msg--${props.className}`}>
      <div className="msg-role">{props.role}</div>
      <div className="msg-text">{props.text}</div>
    </div>
  )
}

/**
 * Linha de tool.
 *
 * `ok` indefinido significa "ainda a correr" — é o estado inicial de uma
 * `tool_use_start` antes de o `tool_end` trazer o resultado e a duração.
 */
export function ToolRow(props: { message: Message }): ReactNode {
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
    </details>
  )
}

/** Versão por omissão de uma linha da conversa, por `kind`. */
function DefaultItem(props: { message: Message }): ReactNode {
  const message = props.message
  switch (message.kind) {
    case 'user':
      return <MessageBubble role="tu" className="user" text={message.text} />
    case 'assistant':
      return <MessageBubble role="agente" className="assistant" text={message.text} />
    case 'error':
      return <MessageBubble role="erro" className="error" text={message.text} />
    case 'tool':
      return <ToolRow message={message} />
  }
}

/**
 * Uma entrada da conversa, com o slot por tipo de item à frente.
 *
 * Se o slot `chat.item.<kind>` tiver inscrições, desenha-as e ignora a
 * versão por omissão — é assim que um plugin toma conta de um tipo de item
 * sem o shell o conhecer.
 */
export function ConversationItem(props: { message: Message }): ReactNode {
  const slot = itemSlot(props.message)
  const entries = useSlotEntries(slot)
  if (entries.length === 0) return <DefaultItem message={props.message} />
  return (
    <>
      {entries.map((entry) => {
        const Component = entry.component as (p: { message: Message }) => ReactNode
        return <Component key={entry.id} message={props.message} />
      })}
    </>
  )
}

/**
 * A conversa inteira, rolada para o fim sempre que cresce.
 *
 * O auto-scroll vive aqui (e não no componente pai) porque é propriedade
 * desta vista: ela é que sabe onde está o fim do conteúdo.
 */
export function ConversationView(props: { conversation: Conversation }): ReactNode {
  const scroller = useRef<HTMLDivElement | null>(null)
  const { messages } = props.conversation

  useEffect(() => {
    const node = scroller.current
    if (node) node.scrollTop = node.scrollHeight
  }, [messages])

  return (
    <div className="messages" aria-live="polite" ref={scroller}>
      {messages.map((message, index) => (
        <ConversationItem key={index} message={message} />
      ))}
      <Slot name={SLOTS.messagesAfter} />
    </div>
  )
}
