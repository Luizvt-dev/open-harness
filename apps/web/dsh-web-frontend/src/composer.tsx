// ---------------------------------------------------------------------------
// Composer: a caixa de texto e a linha de acções (estado, cancelar, enviar).
//
// Mantém-se um `<form>` como na UI vanilla, porque dá `Enter` para enviar e
// `Shift+Enter` para quebrar linha sem JS extra — e porque um formulário
// continua acessível com teclado e leitores de ecrã.
// ---------------------------------------------------------------------------

import { useEffect, useRef, useState, type ReactNode, type FormEvent } from 'react'
import { Slot } from '@open-harness/dsh-client-ui-slots'
import { SLOTS } from './slots.js'

export interface ComposerProps {
  running: boolean
  status: string
  statusIsError: boolean
  onSubmit: (text: string) => void
  onCancel: () => void
}

export function Composer(props: ComposerProps): ReactNode {
  const [text, setText] = useState('')
  const input = useRef<HTMLTextAreaElement | null>(null)

  // Foco inicial: o shell abre a caixa pronta a escrever, tal como a UI
  // vanilla fazia no `boot()`.
  useEffect(() => {
    input.current?.focus()
  }, [])

  // O turno acabou: limpa a caixa para a próxima pergunta. A limpeza vive
  // aqui e não no `onSubmit` para que o texto escrito durante um turno com
  // cancelamento não desapareça com um erro de rede.
  useEffect(() => {
    if (!props.running) setText('')
  }, [props.running])

  function submit(event: FormEvent): void {
    event.preventDefault()
    const value = text.trim()
    if (props.running || !value) return
    props.onSubmit(value)
    setText('')
  }

  // Cresce com o texto, com teto para não comer a conversa (paridade com a
  // UI vanilla, que fazia isto por estilos inline).
  function autoGrow(node: HTMLTextAreaElement | null): void {
    if (!node) return
    node.style.height = 'auto'
    node.style.height = `${Math.min(node.scrollHeight, 200)}px`
  }

  useEffect(() => {
    autoGrow(input.current)
  }, [text])

  return (
    <form className="composer" onSubmit={submit}>
      <Slot name={SLOTS.composerBefore} />
      <textarea
        className="input"
        rows={2}
        placeholder="Escreve uma mensagem… (Enter envia, Shift+Enter quebra linha)"
        value={text}
        ref={input}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) submit(event)
        }}
      />
      <div className="actions">
        <span
          className={props.statusIsError && props.status ? 'status status--error' : 'status'}
          role="status"
        >
          {props.status}
        </span>
        <button
          className="button button--alert"
          hidden={!props.running}
          type="button"
          onClick={props.onCancel}
        >
          Cancelar
        </button>
        <button className="button button--primary" disabled={props.running} type="submit">
          Enviar
        </button>
      </div>
      <Slot name={SLOTS.composerAfter} />
    </form>
  )
}
