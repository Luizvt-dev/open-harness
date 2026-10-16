// ---------------------------------------------------------------------------
// Itens `user` e `error` — as bolhas do lado de quem escreve.
//
// O que muda face ao shell é só a linha de acções: copiar a mensagem que se
// enviou é o que se faz para a repetir noutro lado; copiar o erro é o que se
// faz para o reportar. O resto (class names, papel, texto) é idêntico ao
// `MessageBubble` do shell, porque uma inscrição substitui o item inteiro.
// ---------------------------------------------------------------------------

import type { ReactNode } from 'react'
import { CopyButton, type Message } from '@open-harness/dsh-web-frontend'

/** Bolha de texto com a sua linha de acções. */
function Bubble(props: { kind: 'user' | 'error'; text: string }): ReactNode {
  const isUser = props.kind === 'user'
  return (
    <div className={`msg msg--${props.kind}`}>
      <div className="msg-role">{isUser ? 'tu' : 'erro'}</div>
      <div className="msg-text">{props.text}</div>
      <div className="msg-actions">
        <CopyButton
          className="msg-copy"
          label={isUser ? 'copiar mensagem' : 'copiar erro'}
          text={props.text}
        />
      </div>
    </div>
  )
}

/**
 * Um item da conversa para os slots `chat.item.user` e `chat.item.error`.
 *
 * Um único componente nos dois slots: o shell entrega a `Message` inteira e
 * quem decide o desenho é o `kind` — registar dois componentes iguais seria
 * duas cópias desta função.
 */
export function ChatItem(props: { message: Message }): ReactNode {
  const { message } = props
  if (message.kind === 'user') return <Bubble kind="user" text={message.text} />
  if (message.kind === 'error') return <Bubble kind="error" text={message.text} />
  return null
}
