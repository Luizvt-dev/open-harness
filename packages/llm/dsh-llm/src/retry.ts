import { LlmAbortedError, LlmError } from './errors.js'

export interface RetryPolicy {
  /** Tentativas no total (mínimo 1 = sem retry). Default 4. */
  maxAttempts: number
  /** Delay da 1ª repetição em ms. Default 500. */
  baseDelayMs: number
  /** Teto do delay em ms. Default 30 000. */
  maxDelayMs: number
  /** Multiplicador do backoff exponencial. Default 2. */
  factor: number
  /** Jitter fracionário (0 = sem jitter, 1 = até 100 % extra). Default 0.5. */
  jitter: number
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  factor: 2,
  jitter: 0.5,
}

/** Delay da repetição `attempt` (1-based) com backoff exponencial + jitter. */
export function retryDelay(policy: RetryPolicy, attempt: number, random = Math.random): number {
  const raw = policy.baseDelayMs * policy.factor ** (attempt - 1)
  const capped = Math.min(raw, policy.maxDelayMs)
  return Math.round(capped * (1 + policy.jitter * random()))
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

export interface RetryOptions {
  policy?: Partial<RetryPolicy>
  signal?: AbortSignal
  /** Chamado antes de cada espera (telemetria/UI). */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void
  /** Sleep injectável (testes). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** Avaliador injectável de retryabilidade. Default: `LlmError.retryable`. */
  isRetryable?: (error: unknown) => boolean
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new LlmAbortedError())
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new LlmAbortedError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function defaultIsRetryable(error: unknown): boolean {
  if (error instanceof LlmError) return error.retryable
  return isAbortError(error) ? false : false
}

/**
 * Executa `fn` com retry: só repete erros retryáveis (backoff exponencial +
 * jitter), respeita `AbortSignal` e nunca dorme depois do aborto.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...options.policy }
  const sleep = options.sleep ?? defaultSleep
  const isRetryable = options.isRetryable ?? defaultIsRetryable
  const maxAttempts = Math.max(1, policy.maxAttempts)

  let lastError: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (options.signal?.aborted) throw new LlmAbortedError()
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (isAbortError(error)) throw error
      if (attempt === maxAttempts || !isRetryable(error)) throw error
      const delay = retryDelay(policy, attempt)
      options.onRetry?.(error, attempt, delay)
      await sleep(delay, options.signal)
    }
  }
  throw lastError
}
