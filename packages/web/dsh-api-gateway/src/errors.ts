// ---------------------------------------------------------------------------
// Erro remoto
//
// É o equivalente ao `RemoteError` do Typert: o único tipo de erro que cruza
// o transporte. Qualquer throw interno é traduzido para aqui antes de sair,
// para não vazar stack traces nem tipos internos para o navegador.
// ---------------------------------------------------------------------------

/** Códigos de erro do protocolo. */
export const REMOTE_ERROR_CODES = [
  'method_not_found',
  'invalid_params',
  'cancelled',
  'unauthorized',
  'unavailable',
  'internal',
] as const

export type RemoteErrorCode = (typeof REMOTE_ERROR_CODES)[number] | (string & {})

export interface RemoteErrorShape {
  code: RemoteErrorCode
  message: string
  data?: unknown
}

/** Erro transportável entre host e cliente. */
export class RemoteError extends Error implements RemoteErrorShape {
  readonly code: RemoteErrorCode
  readonly data?: unknown

  constructor(code: RemoteErrorCode, message: string, data?: unknown) {
    super(message)
    this.name = 'RemoteError'
    this.code = code
    if (data !== undefined) this.data = data
  }

  /** Forma serializável (o que viaja na moldura `error`). */
  toShape(): RemoteErrorShape {
    const shape: RemoteErrorShape = { code: this.code, message: this.message }
    if (this.data !== undefined) shape.data = this.data
    return shape
  }

  /** Reconstrói a partir de uma moldura recebida. */
  static fromShape(shape: RemoteErrorShape): RemoteError {
    return new RemoteError(shape.code, shape.message, shape.data)
  }

  /**
   * Normaliza qualquer throw.
   *
   * Um `RemoteError` mantém-se; o resto vira `internal`. Um `AbortError`
   * (cancelamento) vira `cancelled`, que é um estado legítimo, não uma falha.
   */
  static from(value: unknown): RemoteError {
    if (value instanceof RemoteError) return value
    const error = value as { name?: string; message?: string }
    if (error?.name === 'AbortError') return new RemoteError('cancelled', 'call cancelled')
    return new RemoteError('internal', error?.message ?? String(value))
  }
}
