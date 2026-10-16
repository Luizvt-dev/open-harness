import { RemoteError, type RemoteSpec } from '@open-harness/dsh-api-gateway'
import { eventsToStream } from './queue.js'
import { sessionInfo, type AgentEvent, type AgentHost, type CreateSessionOptions } from './types.js'

/** Busca a sessão ou falha com uma mensagem que já nomeia o id. */
function requireSession(host: AgentHost, sessionId: unknown) {
  if (typeof sessionId !== 'string' || !sessionId) {
    throw new RemoteError('invalid_params', 'sessionId is required')
  }
  const handle = host.get(sessionId)
  if (!handle) throw new RemoteError('invalid_params', `unknown session "${sessionId}"`)
  return handle
}

/**
 * Remote `session.*` — criar, listar, ver e remover sessões.
 *
 * Uma sessão é um agente com o seu próprio estado (mensagens, tools, modelo).
 * O host é quem decide quantas existem e onde vivem; aqui só se expõe.
 */
export function sessionRemote(host: AgentHost): RemoteSpec {
  return {
    namespace: 'session',
    methods: {
      create: {
        handler: async (params: CreateSessionOptions) => sessionInfo(await host.create(params ?? {})),
      },
      list: {
        handler: async () => ({ sessions: host.list().map(sessionInfo) }),
      },
      get: {
        handler: async (params: { sessionId: string }) => sessionInfo(requireSession(host, params?.sessionId)),
      },
      history: {
        handler: async (params: { sessionId: string }) => ({
          entries: requireSession(host, params?.sessionId).history(),
        }),
      },
      remove: {
        handler: async (params: { sessionId: string }) => {
          requireSession(host, params?.sessionId)
          await host.remove(params.sessionId)
          return { ok: true }
        },
      },
    },
  }
}

/** Um job em curso, cancelável. */
interface RunningJob {
  sessionId: string
  cancel(): void
}

/**
 * Remote `job.*` — correr um turno como um stream de eventos.
 *
 * `job.run` é o método central da superfície web: o primeiro evento dá o
 * `jobId`, os seguintes são a narrativa do turno (texto a aparecer, tools a
 * começar e a terminar) e o último é o `turn_end`. Cancelar fecha o sinal,
 * que o loop sente entre passos.
 */
export function jobRemote(host: AgentHost): RemoteSpec {
  let counter = 0
  const running = new Map<string, RunningJob>()

  return {
    namespace: 'job',
    methods: {
      run: {
        kind: 'stream',
        async *handler(params: { sessionId: string; text: string }, ctx) {
          const handle = requireSession(host, params?.sessionId)
          const text = typeof params?.text === 'string' ? params.text : ''
          if (!text.trim()) throw new RemoteError('invalid_params', 'text is required')

          const jobId = `job_${++counter}`
          const controller = new AbortController()
          const cancel = (): void => {
            handle.cancel()
            controller.abort()
          }
          running.set(jobId, { sessionId: handle.id, cancel })

          // O transporte manda no cancelamento também: uma ligação que cai a
          // meio do turno não deixa o agente a trabalhar para ninguém.
          const onTransportAbort = (): void => cancel()
          ctx.signal.addEventListener('abort', onTransportAbort, { once: true })

          try {
            yield { type: 'job_start', jobId, sessionId: handle.id }
            const events = eventsToStream<AgentEvent>((push) => handle.run(text, push, controller.signal))
            for await (const event of events) yield event
          } finally {
            ctx.signal.removeEventListener('abort', onTransportAbort)
            running.delete(jobId)
          }
        },
      },
      cancel: {
        handler: (params: { jobId: string }) => {
          const job = running.get(String(params?.jobId ?? ''))
          if (!job) throw new RemoteError('invalid_params', `unknown job "${params?.jobId}"`)
          job.cancel()
          return { ok: true }
        },
      },
      list: {
        handler: () => ({
          jobs: [...running.entries()].map(([jobId, job]) => ({ jobId, sessionId: job.sessionId })),
        }),
      },
    },
  }
}
