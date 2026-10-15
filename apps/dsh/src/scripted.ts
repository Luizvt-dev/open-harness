import type {
  LlmAdapter,
  LlmCallOptions,
  LlmRequest,
  LlmResponse,
  LlmStreamEvent,
} from '@open-harness/dsh-llm'

/**
 * Adaptador `LlmAdapter` que devolve uma sequência fixa de respostas, sem
 * rede. Útil para testes de integração determinísticos e para o modo offline
 * da CLI `dsh` (`--offline`).
 *
 * Cada chamada a `complete` consome a próxima resposta da fila; quando a fila
 * esvazia, devolve uma resposta final vazia (`end_turn`).
 */
export class ScriptedAdapter implements LlmAdapter {
  readonly id = 'scripted'
  private readonly queue: LlmResponse[]
  private readonly fallback: LlmResponse | undefined
  /** Todos os pedidos recebidos, para asserções. */
  readonly requests: LlmRequest[] = []

  /**
   * `fallback` é a resposta usada quando a fila acaba. Na CLI (`dsh "…"`) a
   * fila chega e basta; no modo web há turnos ilimitados, e devolver uma
   * resposta vazia a cada um seria confuso — melhor um eco determinístico.
   */
  constructor(responses: LlmResponse[], fallback?: LlmResponse) {
    this.queue = [...responses]
    this.fallback = fallback
  }

  async complete(request: LlmRequest, _options?: LlmCallOptions): Promise<LlmResponse> {
    this.requests.push(request)
    const next = this.queue.shift() ?? this.fallback
    if (next) return next
    return {
      model: request.model,
      content: [],
      stopReason: 'end_turn',
      usage: { inputTokens: 0, outputTokens: 0 },
    }
  }

  /**
   * Mesmas respostas, em forma de stream.
   *
   * O loop usa o caminho de stream quando tem observador — é o caso da
   * superfície web —, por isso o adapter scriptável tem de falar os dois
   * registos. Sem isto, o modo offline devolveria uma resposta vazia a cada
   * turno quando alguém olhava para os eventos.
   */
  async *stream(request: LlmRequest, _options?: LlmCallOptions): AsyncGenerator<LlmStreamEvent> {
    this.requests.push(request)
    const next = this.queue.shift() ?? this.fallback
    yield { type: 'message_start', id: 'msg_scripted', model: next?.model ?? request.model }
    if (next) {
      for (const block of next.content) {
        if (block.type === 'text') {
          yield { type: 'text_delta', text: block.text }
        } else if (block.type === 'tool_use') {
          yield { type: 'tool_use_start', id: block.id, name: block.name }
          yield { type: 'tool_use_delta', partialJson: JSON.stringify(block.input) }
          yield { type: 'tool_use_stop', id: block.id }
        }
      }
    }
    yield {
      type: 'message_delta',
      stopReason: next?.stopReason ?? 'end_turn',
      usage: next?.usage ?? { inputTokens: 0, outputTokens: 0 },
    }
    yield { type: 'message_stop' }
  }
}

/** Helper para montar uma resposta de texto simples. */
export function scriptedText(text: string): LlmResponse {
  return {
    model: 'scripted',
    content: [{ type: 'text', text }],
    stopReason: 'end_turn',
    usage: { inputTokens: 1, outputTokens: 1 },
  }
}

/** Helper para montar uma resposta que pede uma tool `write`. */
export function scriptedWrite(path: string, content: string): LlmResponse {
  return {
    model: 'scripted',
    content: [{ type: 'tool_use', id: `tu_${path}`, name: 'write', input: { path, content } }],
    stopReason: 'tool_use',
    usage: { inputTokens: 1, outputTokens: 1 },
  }
}
