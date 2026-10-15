/**
 * Ponte entre um produtor por callback e um `AsyncIterable`.
 *
 * O loop do agente fala por callback (é o que o `onEvent` é); o transporte RPC
 * fala por `yield`. A fila faz a ponte sem perder eventos e sem que o
 * produtor espere pelo consumidor — o browser pode estar mais lento do que o
 * modelo a gerar texto.
 */
export async function* eventsToStream<T>(
  run: (push: (event: T) => void) => Promise<unknown>,
): AsyncGenerator<T> {
  const buffer: T[] = []
  let settled = false
  let failure: unknown
  let hasFailure = false
  let wake: (() => void) | undefined

  const pump = (): void => {
    const resume = wake
    wake = undefined
    resume?.()
  }

  void run((event) => {
    buffer.push(event)
    pump()
  }).then(
    () => {
      settled = true
      pump()
    },
    (error: unknown) => {
      failure = error
      hasFailure = true
      settled = true
      pump()
    },
  )

  while (true) {
    while (buffer.length > 0) yield buffer.shift() as T
    if (settled) {
      // Re-lança a falha do produtor no ponto onde ela aconteceu.
      if (hasFailure) throw failure
      return
    }
    await new Promise<void>((resolve) => {
      wake = resolve
    })
  }
}
