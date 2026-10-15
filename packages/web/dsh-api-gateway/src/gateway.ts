import { RemoteError } from './errors.js'
import type {
  CallContext,
  MethodSpec,
  RemoteSpec,
  StreamMethodSpec,
  UnaryMethodSpec,
} from './types.js'

/**
 * Registry de métodos remotos.
 *
 * O gateway não sabe nada de HTTP nem de WebSocket: recebe um método, uns
 * parâmetros e um contexto (sinal de cancelamento + canal downlink), e devolve
 * um valor ou um iterable. Assim o mesmo registry serve o mux WebSocket, o
 * caminho HTTP/SSE e, mais à frente, o transporte do Electron.
 */
export class Gateway {
  private readonly methods = new Map<string, MethodSpec>()

  /** Regista um método (`session.create`). */
  register(method: string, spec: MethodSpec): this {
    this.methods.set(method, spec)
    return this
  }

  /** Regista todos os métodos de um remote, aplicando o namespace. */
  registerRemote(remote: RemoteSpec): this {
    for (const [name, spec] of Object.entries(remote.methods)) {
      const full = remote.namespace ? `${remote.namespace}.${name}` : name
      this.register(full, spec)
    }
    return this
  }

  /** O método existe? */
  has(method: string): boolean {
    return this.methods.has(method)
  }

  /** Tipo do método, ou `null` se não existir. */
  kindOf(method: string): 'unary' | 'stream' | null {
    const spec = this.methods.get(method)
    if (!spec) return null
    return isStream(spec) ? 'stream' : 'unary'
  }

  /** Métodos registados, ordenados (para o `welcome`). */
  list(): string[] {
    return [...this.methods.keys()].sort()
  }

  /** Chama um método unary. */
  async call(method: string, params: unknown, ctx: CallContext): Promise<unknown> {
    const spec = this.resolve(method)
    if (isStream(spec)) {
      throw new RemoteError(
        'invalid_params',
        `"${method}" is a stream method; use the streaming path`,
      )
    }
    const handler = (spec as UnaryMethodSpec<never, unknown>).handler
    return await handler.call(undefined, params as never, ctx)
  }

  /** Itera os eventos de um método de stream. */
  async *stream(method: string, params: unknown, ctx: CallContext): AsyncGenerator<unknown> {
    const spec = this.resolve(method)
    if (!isStream(spec)) {
      throw new RemoteError(
        'invalid_params',
        `"${method}" is a unary method; use the unary path`,
      )
    }
    const iterable = (spec as StreamMethodSpec<never, unknown>).handler.call(
      undefined,
      params as never,
      ctx,
    )
    for await (const item of iterable) {
      // O cancelamento tem de ser sentido também entre itens: um handler que
      // faça trabalho longo entre yields atrasa-se a reparar que caiu.
      if (ctx.signal.aborted) return
      yield item
    }
  }

  private resolve(method: string): MethodSpec {
    const spec = this.methods.get(method)
    if (!spec) throw this.methodNotFound(method)
    return spec
  }

  /**
   * Erro `method_not_found`, com a lista dos métodos existentes.
   *
   * Fica público porque o mux também o precisa quando o método não consta do
   * registry — assim o cliente recebe a mesma mensagem por qualquer transporte.
   */
  methodNotFound(method: string): RemoteError {
    return new RemoteError('method_not_found', `unknown method "${method}"`, {
      method,
      known: this.list(),
    })
  }
}

function isStream(spec: MethodSpec): boolean {
  return (spec as StreamMethodSpec).kind === 'stream'
}

/** Atalho: cria um registry já com os remotes registados. */
export function createGateway(remotes: RemoteSpec[] = []): Gateway {
  const gateway = new Gateway()
  for (const remote of remotes) gateway.registerRemote(remote)
  return gateway
}
