/** Erros do kernel. */

export class CordisError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/** Contexto/fibra já em dispose (ou depois dele). */
export class DisposedError extends CordisError {
  constructor(readonly target: string) {
    super(`${target} has been disposed`)
  }
}

/** Serviço pedido mas ainda não provido. */
export class ServiceUnavailableError extends CordisError {
  constructor(readonly serviceName: string) {
    super(`service "${serviceName}" is not available`)
  }
}

/** Dois fibers a providir o mesmo slot single, ou provide() com cardinalidade divergente. */
export class ServiceConflictError extends CordisError {}

/** Definição de plugin inválida (não é função nem objeto com `apply`). */
export class InvalidPluginError extends CordisError {}
