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
  /** Todos os pedidos recebidos, para asserções. */
  readonly requests: LlmRequest[] = []

  constructor(responses: LlmResponse[]) {
    this.queue = [...responses]
  }

  async complete(request: LlmRequest, _options?: LlmCallOptions): Promise<LlmResponse> {
    this.requests.push(request)
    const next = this.queue.shift()
    if (next) return next
    return {
      model: request.model,
      content: [],
      stopReason: 'end_turn',
      usage: { inputTokens: 0, outputTokens: 0 },
    }
  }

  // `stream` não é usado pelo `AgentLoop` (usa `complete`), mas a interface
  // exige-o; devolve um iterable vazio para não quebrar quem chamar.
  async *stream(_request: LlmRequest, _options?: LlmCallOptions): AsyncGenerator<LlmStreamEvent> {
    // vazio — nenhum evento
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
