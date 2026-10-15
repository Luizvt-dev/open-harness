// ---------------------------------------------------------------------------
// Erros
// ---------------------------------------------------------------------------

/** Código estável para classificação programática. */
export type LlmErrorCode =
  | 'aborted'
  | 'timeout'
  | 'rate-limit'
  | 'auth'
  | 'invalid-request'
  | 'server'
  | 'network'
  | 'unknown'

/**
 * Erro base do domínio LLM. `retryable` diz se faz sentido repetir a operação
 * (o `withRetry` usa-o; o chamador pode usá-lo para mensagens ao utilizador).
 */
export class LlmError extends Error {
  constructor(
    message: string,
    readonly code: LlmErrorCode,
    readonly retryable: boolean,
    options?: { cause?: unknown; status?: number },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'LlmError'
    this.status = options?.status
  }

  /** Status HTTP quando o erro veio de uma resposta. */
  readonly status?: number
}

/** Pedido abortado pelo chamador (`AbortSignal`). */
export class LlmAbortedError extends LlmError {
  constructor(message = 'LLM request aborted', options?: { cause?: unknown }) {
    super(message, 'aborted', false, options)
    this.name = 'LlmAbortedError'
  }
}

/** Timeout (idle de stream ou total do pedido). */
export class LlmTimeoutError extends LlmError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'timeout', true, options)
    this.name = 'LlmTimeoutError'
  }
}

/** 429 / erro de quota — retryável com backoff. */
export class LlmRateLimitError extends LlmError {
  constructor(message: string, options?: { cause?: unknown; status?: number }) {
    super(message, 'rate-limit', true, options)
    this.name = 'LlmRateLimitError'
  }
}

/** 401/403 — chave inválida ou sem acesso; nunca retryável. */
export class LlmAuthError extends LlmError {
  constructor(message: string, options?: { cause?: unknown; status?: number }) {
    super(message, 'auth', false, options)
    this.name = 'LlmAuthError'
  }
}

/** 400/404/413… — o pedido em si está mal; nunca retryável. */
export class LlmInvalidRequestError extends LlmError {
  constructor(message: string, options?: { cause?: unknown; status?: number }) {
    super(message, 'invalid-request', false, options)
    this.name = 'LlmInvalidRequestError'
  }
}

/** 5xx — retryável. */
export class LlmServerError extends LlmError {
  constructor(message: string, options?: { cause?: unknown; status?: number }) {
    super(message, 'server', true, options)
    this.name = 'LlmServerError'
  }
}

/** Falha de rede (DNS, ligação, reset) — retryável. */
export class LlmNetworkError extends LlmError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'network', true, options)
    this.name = 'LlmNetworkError'
  }
}

/** Mapeia um status HTTP para o erro tipado correspondente. */
export function errorFromStatus(status: number, message: string): LlmError {
  if (status === 429) return new LlmRateLimitError(message, { status })
  if (status === 401 || status === 403) return new LlmAuthError(message, { status })
  if (status >= 500) return new LlmServerError(message, { status })
  return new LlmInvalidRequestError(message, { status })
}
