// ---------------------------------------------------------------------------
// Parser SSE (text/event-stream) — transporte comum a todos os protocolos
// (Anthropic Messages, OpenAI Chat Completions, Google generateContent).
// ---------------------------------------------------------------------------

export interface SseEvent {
  /** Campo `event:` (default 'message'). */
  event: string
  /** Campo `data:` (concatenado por linhas, como manda a especificação). */
  data: string
}

/**
 * Parser SSE incremental: consome chunks de texto e emite eventos completos.
 * Tolera CRLF, eventos sem `event:`, e `data:` multi-linha.
 */
export class SseParser {
  private buffer = ''
  private eventName = ''
  private dataLines: string[] = []

  /** Alimenta um chunk; devolve os eventos completados por ele. */
  push(chunk: string): SseEvent[] {
    this.buffer += chunk
    const events: SseEvent[] = []
    for (;;) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) break
      const line = this.buffer.slice(0, newline).replace(/\r$/, '')
      this.buffer = this.buffer.slice(newline + 1)
      if (line === '') {
        const event = this.flush()
        if (event) events.push(event)
        continue
      }
      if (line.startsWith(':')) continue // comentário / keep-alive
      const colon = line.indexOf(':')
      const field = colon < 0 ? line : line.slice(0, colon)
      let value = colon < 0 ? '' : line.slice(colon + 1)
      if (value.startsWith(' ')) value = value.slice(1)
      if (field === 'event') this.eventName = value
      else if (field === 'data') this.dataLines.push(value)
    }
    return events
  }

  /** Fecha o stream e devolve um evento pendente, se houver. */
  end(): SseEvent | null {
    return this.flush()
  }

  private flush(): SseEvent | null {
    if (this.dataLines.length === 0 && !this.eventName) return null
    const event: SseEvent = { event: this.eventName || 'message', data: this.dataLines.join('\n') }
    this.eventName = ''
    this.dataLines = []
    return event
  }
}
