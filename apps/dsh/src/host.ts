import { createAgentService, type AgentService, type AgentServiceConfig } from '@open-harness/dsh-agent'
import { newSessionId } from '@open-harness/dsh-session'
import type {
  AgentEvent,
  AgentHost,
  CreateSessionOptions,
  SessionHandle,
  TurnSummary,
} from '@open-harness/dsh-api-remotes'

/** Opções do host de sessões. */
export interface ServiceHostOptions {
  /** Directório de trabalho por omissão das sessões novas. */
  cwd?: string
}

/**
 * Host de sessões por cima do `AgentService` do perfil.
 *
 * O serviço cordis do perfil é o **modelo**: cada sessão da superfície web é
 * um agente irmão — mesmo modelo, mesmo system prompt, mesmo adapter e mesmas
 * tools — e só o estado difere (histórico em memória e ficheiro em disco).
 * Assim dá para ter várias conversas abertas sem recompilar perfis nem
 * duplicar configuração.
 */
export function createServiceHost(template: AgentService, options: ServiceHostOptions = {}): AgentHost {
  const sessions = new Map<string, ServiceSession>()

  return {
    async create(createOptions: CreateSessionOptions): Promise<SessionHandle> {
      const config: AgentServiceConfig = {
        ...template.config,
        ...(createOptions.cwd !== undefined
          ? { cwd: createOptions.cwd }
          : options.cwd !== undefined
            ? { cwd: options.cwd }
            : {}),
        ...(createOptions.model !== undefined ? { model: createOptions.model } : {}),
        // Sessão nova = identidade nova — o ficheiro em disco segue o id.
        sessionId: newSessionId(),
      }

      const service = createAgentService(config)
      // As tools registadas no serviço do perfil seguem para as sessões novas.
      for (const name of template.tools.names()) {
        const def = template.tools.get(name)
        if (def && !service.tools.has(name)) service.tools.register(def)
      }

      const session = new ServiceSession(service, createOptions.title)
      sessions.set(session.id, session)
      return session
    },

    get(id: string): SessionHandle | undefined {
      return sessions.get(id)
    },

    list(): SessionHandle[] {
      return [...sessions.values()]
    },

    async remove(id: string): Promise<void> {
      sessions.get(id)?.cancel()
      sessions.delete(id)
    },
  }
}

/**
 * Uma sessão vista do transporte.
 *
 * Cancelamento é cooperativo: cada `run` tem o seu `AbortController` e o
 * `cancel()` aborta-o — o loop do agente sente o sinal entre passos e para de
 * chamar o modelo. Isto também cobre a queda da ligação, porque o `job.run`
 * liga o sinal do transporte ao `run`.
 */
class ServiceSession implements SessionHandle {
  readonly id: string
  readonly cwd: string
  readonly model: string
  readonly modelRef: string
  readonly title: string
  readonly createdAt = Date.now()
  running = false

  private readonly service: AgentService
  private active: AbortController | undefined

  constructor(service: AgentService, title?: string) {
    this.service = service
    this.id = service.session.id
    this.cwd = service.session.header.cwd
    this.model = service.model
    this.modelRef = service.modelRef
    this.title = title?.trim() || `Sessão ${this.id.slice(0, 8)}`
  }

  async run(
    text: string,
    onEvent: (event: AgentEvent) => void,
    signal?: AbortSignal,
  ): Promise<TurnSummary> {
    if (this.running) {
      throw new Error(`session ${this.id} already has a turn in progress`)
    }
    const controller = new AbortController()
    const forward = (): void => controller.abort()
    signal?.addEventListener('abort', forward, { once: true })
    this.active = controller
    this.running = true
    try {
      const outcome = await this.service.run(text, controller.signal, (event) => {
        // O vocabulário do fio é o do loop — a conversão é intencionalmente
        // uma atribuição: se o loop mudar o tipo, o compilador avisa aqui.
        onEvent(event as AgentEvent)
      })
      return {
        text: outcome.text,
        steps: outcome.steps,
        toolCount: outcome.toolExecutions.length,
        stoppedByLimit: outcome.stoppedByLimit,
      }
    } finally {
      signal?.removeEventListener('abort', forward)
      this.active = undefined
      this.running = false
    }
  }

  cancel(): void {
    this.active?.abort()
  }
}
