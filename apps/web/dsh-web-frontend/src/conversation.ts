// ---------------------------------------------------------------------------
// Modelo da conversa — lógica pura, sem DOM e sem React.
//
// A UI vanilla desenhava o turno directamente no DOM à medida que os eventos
// chegavam (uma bolha em curso, um mapa de linhas de tool). Aqui a mesma
// regra vive num reducer puro: cada evento devolve uma lista nova de
// mensagens, e o componente só desenha o resultado.
//
// Manter isto separado é o que permite testar o streaming sem browser — e é
// a peça onde os bugs de ordem da conversa acontecem (uma tool a fechar a
// bolha de texto em curso, texto a chegar depois da tool a abrir outra
// bolha, e por diante).
// ---------------------------------------------------------------------------

import type { AgentEvent, HistoryEntry } from './types.js'

/** Uma linha da conversa, pronta a renderizar. */
export type Message =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'error'; text: string }
  | {
      kind: 'tool'
      id: string
      name: string
      /** `undefined` = ainda a correr. */
      ok?: boolean
      durationMs?: number
      output?: string
    }

/**
 * Estado da conversa em curso.
 *
 * `bubble` é o índice da bolha de texto aberta (ou `null` quando não há
 * nenhuma); `tools` guarda o índice de cada linha de tool pelo id, para o
 * `tool_end` actualizar a certa mesmo com várias tools em paralelo.
 */
export interface Conversation {
  messages: Message[]
  bubble: number | null
  tools: Record<string, number>
}

/** Conversa vazia. */
export function emptyConversation(): Conversation {
  return { messages: [], bubble: null, tools: {} }
}

/** Reconstrói a conversa do histórico persistido (arranque e troca de sessão). */
export function fromHistory(entries: HistoryEntry[]): Conversation {
  const conversation = emptyConversation()
  conversation.messages = entries.map((entry) => {
    if (entry.kind === 'tool') {
      return {
        kind: 'tool' as const,
        id: entry.id,
        name: entry.name,
        ...(entry.ok !== undefined ? { ok: entry.ok } : {}),
        ...(entry.output !== undefined ? { output: entry.output } : {}),
      }
    }
    return { kind: entry.kind, text: entry.text }
  })
  return conversation
}

/** Abre a conversa com a mensagem do utilizador. */
export function appendUser(conversation: Conversation, text: string): Conversation {
  return {
    messages: [...conversation.messages, { kind: 'user', text }],
    // Uma mensagem nova fecha qualquer bolha em curso: o que vier a seguir
    // é resposta ao que o utilizador acabou de dizer.
    bubble: null,
    tools: { ...conversation.tools },
  }
}

/**
 * Aplica um evento do turno.
 *
 * A regra da ordem, igual à da UI vanilla: cada `tool_use_start` fecha a
 * bolha de texto em curso, e se depois houver mais texto abre-se outra. Assim
 * a conversa conta a história pela ordem em que o agente a viveu.
 */
export function applyEvent(conversation: Conversation, event: AgentEvent): Conversation {
  const messages = [...conversation.messages]
  let { bubble } = conversation
  const tools = { ...conversation.tools }

  switch (event.type) {
    case 'text_delta': {
      if (bubble === null) {
        messages.push({ kind: 'assistant', text: '' })
        bubble = messages.length - 1
      }
      const current = messages[bubble]
      if (current?.kind === 'assistant') {
        messages[bubble] = { kind: 'assistant', text: current.text + event.text }
      }
      break
    }

    case 'tool_use_start': {
      messages.push({ kind: 'tool', id: event.id, name: event.name })
      tools[event.id] = messages.length - 1
      // A tool fecha a bolha em curso — o texto seguinte abre outra.
      bubble = null
      break
    }

    case 'tool_end': {
      const index = tools[event.id]
      if (index !== undefined) {
        messages[index] = {
          kind: 'tool',
          id: event.id,
          name: event.name,
          ok: event.ok,
          durationMs: event.durationMs,
          ...(event.output ? { output: event.output } : {}),
        }
      }
      break
    }

    case 'turn_end': {
      // O texto final é o canónico — substitui o que veio por deltas.
      if (bubble === null) {
        messages.push({ kind: 'assistant', text: event.text })
        bubble = messages.length - 1
      } else {
        messages[bubble] = { kind: 'assistant', text: event.text }
      }
      break
    }

    case 'error': {
      // A UI vanilla acrescentava o erro à conversa sem mexer na bolha em
      // curso: o turno não termina por isso, e o texto seguinte continua a
      // pertencer à mesma resposta.
      messages.push({ kind: 'error', text: `${event.code}: ${event.message}` })
      break
    }

    // `turn_start`/`step_start`/`step_end` não alteram a conversa: são
    // contabilidade do loop, e no ecrã só serviriam de ruído.
    case 'turn_start':
    case 'step_start':
    case 'step_end':
      break
  }

  return { messages, bubble, tools }
}

/** Texto do rodapé de estatísticas, a partir do fim do turno. */
export function turnStats(event: { steps: number; stoppedByLimit: boolean }): string {
  return (
    `${event.steps} ${event.steps === 1 ? 'passo' : 'passos'}` +
    (event.stoppedByLimit ? ' · limite de passos atingido' : '')
  )
}
