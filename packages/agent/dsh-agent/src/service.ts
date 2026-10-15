import { LlmClient, type LlmAdapter } from '@open-harness/dsh-llm'
import {
  DEFAULT_MODEL_REF,
  DEFAULT_PROVIDER_ID,
  ProviderRegistry,
  formatModelRef,
  parseModelRef,
  type ProviderConfig,
} from '@open-harness/dsh-provider'
import { Session, newSessionId, sessionFilePath } from '@open-harness/dsh-session'
import { saveSession } from '@open-harness/dsh-session-persistence-jsonl'
import type { SessionFile } from '@open-harness/dsh-session-format'
import { ToolRegistry, type ToolDefinition } from '@open-harness/dsh-tools'
import { AgentLoop, type TurnOutcome } from '@open-harness/dsh-agent-loop'
import { resolveDshHome } from '@open-harness/home-paths'

/** Configuração composta do plugin do agente. */
export interface AgentServiceConfig {
  /**
   * Provedores declarados (o bloco `providers:` do perfil). Cada entrada pode
   * fixar protocolo, endpoint, chave e catálogo de modelos — é assim que se
   * ligam vários provedores sem mudar código.
   */
  providers?: Record<string, ProviderConfig>
  /** Alias do `providers` na forma do OpenCode (`provider:` é um mapa). */
  provider?: Record<string, ProviderConfig>
  /**
   * Modelo a usar: `provedor/modelo` (ex.: `openai/gpt-5.4`) ou só o id
   * (usa o provedor default). Default `deepseek/deepseek-flash`.
   */
  model?: string
  /** Chave por omissão — atalho para `providers.deepseek.apiKey`. */
  apiKey?: string
  /** Directorio de trabalho do agente. Default `process.cwd()`. */
  cwd?: string
  /** Raiz do home de dados (para a sessão). Default `resolveDshHome()`. */
  homeDir?: string
  /** Nome do perfil (vai para o cabeçalho da sessão). Default `standard`. */
  agentPreset?: string
  /** Compressão da persistência. Default `zstd`. */
  compression?: 'none' | 'zstd'
  /** System prompt. */
  system?: string
  /** Id da sessão; se omitido, gera um novo. */
  sessionId?: string
  /** Adapter LLM injectado (testes/offline); se omitido, resolve pelo registry. */
  adapter?: LlmAdapter
  /** Registry injectado (testes); senão constrói um a partir de `providers`. */
  registry?: ProviderRegistry
}

/** O serviço `agent` publicado no cordis. */
export interface AgentService {
  /** Sessão corrente (fonte de verdade em memória). */
  readonly session: Session
  /** Registry de tools (mutável — plugins podem registar mais). */
  readonly tools: ToolRegistry
  /** Loop pronto a usar. */
  readonly loop: AgentLoop
  /** Registry de provedores (listagem, resolução de modelos). */
  readonly registry: ProviderRegistry
  /** Referência activa, `provedor/modelo`. */
  readonly modelRef: string
  /** Id de modelo enviado ao provider (sem o prefixo do provedor). */
  readonly model: string
  /** Corre um turno completo e persiste a sessão no fim. */
  run(prompt: string, signal?: AbortSignal): Promise<TurnOutcome>
  /** Caminho do ficheiro de sessão em disco. */
  readonly sessionPath: string
}

/** Nome do serviço público. */
export const AGENT_SERVICE = 'agent'

/** Registo de tools por omissão: vazio — o bundle/headless acrescenta as suas. */
export function defaultTools(): ToolDefinition[] {
  return []
}

/** Constrói o registry a partir da configuração do agente. */
export function createAgentRegistry(options: AgentServiceConfig): ProviderRegistry {
  const registry = new ProviderRegistry({ env: process.env })
  if (options.apiKey) registry.configure({ [DEFAULT_PROVIDER_ID]: { apiKey: options.apiKey } })
  const providers = options.providers ?? options.provider
  if (providers) registry.configure(providers)
  return registry
}

/** Constrói o serviço do agente (sem cordis — testável isoladamente). */
export function createAgentService(options: AgentServiceConfig): AgentService {
  const cwd = options.cwd ?? process.cwd()
  const homeDir = options.homeDir
  const compression = options.compression ?? 'zstd'
  const sessionId = options.sessionId ?? newSessionId()
  const registry = options.registry ?? createAgentRegistry(options)

  let adapter: LlmAdapter
  let modelRef: string
  let model: string

  if (options.adapter) {
    // Adapter injectado tem precedência (testes/offline): o registry serve
    // apenas para traduzir a referência no id de modelo que o loop envia.
    const ref = parseModelRef(options.model ?? DEFAULT_MODEL_REF, { defaultProvider: DEFAULT_PROVIDER_ID })
    adapter = options.adapter
    modelRef = formatModelRef(ref)
    model = ref.model
  } else {
    const resolved = registry.resolve(options.model ?? DEFAULT_MODEL_REF)
    adapter = registry.adapterFor(resolved)
    modelRef = formatModelRef(resolved.ref)
    model = resolved.model.id
  }

  const client = new LlmClient({ adapter })
  const session = new Session({ id: sessionId, cwd, agentPreset: options.agentPreset ?? 'standard' })
  const tools = new ToolRegistry().registerAll(defaultTools())

  // Caminho canónico: `<home>/sessions/<workspace>/session-<id>/session.v4.jsonl[.zstd]`.
  const sessionPath = sessionFilePath({
    home: homeDir ?? resolveDshHome(),
    cwd,
    sessionId,
    compression,
  })

  const persister = {
    async save(file: SessionFile): Promise<void> {
      await saveSession(file, sessionPath, { compression })
    },
  }

  const loop = new AgentLoop(client, session, {
    registry: tools,
    model,
    system: options.system,
    persister,
  })

  return {
    session,
    tools,
    loop,
    registry,
    modelRef,
    model,
    sessionPath,
    async run(prompt, signal) {
      const outcome = await loop.runTurn(prompt, signal)
      // Persistência final (o checkpoint já grava antes de cada request, mas o
      // turno pode terminar por limite sem um último flush).
      await persister.save(session.toFile())
      return outcome
    },
  }
}
