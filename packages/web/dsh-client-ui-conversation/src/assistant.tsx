// ---------------------------------------------------------------------------
// Item `assistant` do slot `chat.item.assistant`.
//
// É uma reimplementação fiel da `MessageBubble` do shell (mesmas class names,
// mesmo papel e texto — o ecrã não pode saltitar quando o plugin carrega) com
// uma linha de acções a mais. Uma inscrição substitui a do shell por inteiro,
// logo tudo o que a bolha faz aqui tem de continuar a fazer.
// ---------------------------------------------------------------------------

import type { ReactNode } from 'react'
import { CopyButton, type Message } from '@open-harness/dsh-web-frontend'

/** Bolha do agente: papel, texto e copiar a resposta. */
export function AssistantItem(props: { message: Message }): ReactNode {
  const { message } = props
  // O shell só invoca este componente no slot do tipo `assistant`; o guarda
  // existe porque a prop é `Message` (união) e aqui o tipo tem de afinar.
  if (message.kind !== 'assistant') return null

  return (
    <div className="msg msg--assistant">
      <div className="msg-role">agente</div>
      <div className="msg-text">{message.text}</div>
      <div className="msg-actions">
        <CopyButton className="msg-copy" label="copiar resposta" text={message.text} />
      </div>
    </div>
  )
}
