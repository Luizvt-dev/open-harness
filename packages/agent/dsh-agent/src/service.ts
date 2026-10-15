import { LlmClient, type LlmAdapter } from '@open-harness/dsh-llm'
import { DeepSeekAdapter } from '@open-harness/dsh-llm-deepseek'
import { Session, newSessionId, sessionFilePath } from '@open-harness/dsh-session'
import { saveSession } from '@open-harness/dsh-session-persistence-jsonl'
import type { SessionFile } from '@open-harness/dsh-session-format'
import { ToolRegistry, type ToolDefinition } from '@open-harness/dsh-tools'
import { AgentLoop, type TurnOutcome } from '@open-harness/dsh-agent-loop'
import { resolveDshHome } from '@open-harness/home-paths'

/** Configuração composta do plugin do agente. */
export interface AgentServiceConfig {
  /** Chave da API DeepSeek. Default: `process.env.DEEPSEEK_API_KEY`. */
  apiKey?: string
  /** Modelo por omissão. Default `deepseek-flash`. */
  model?: string
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
  /** Adapter LLM injectado (testes/offline); se omitido, usa DeepSeek. */
  adapter?: LlmAdapter
}

/** O serviço `agent` publicado no cordis. */
export interface AgentService {
  /** Sessão corrente (fonte de verdade em memória). */
  readonly session: Session
  /** Registry de tools (mutável — plugins podem registar mais). */
  readonly tools: ToolRegistry
  /** Loop pronto a usar. */
  readonly loop: AgentLoop
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

/** Constrói o serviço do agente (sem cordis — testável isoladamente). */
export function createAgentService(options: AgentServiceConfig): AgentService {
  const model = options.model ?? 'deepseek-flash'
  const cwd = options.cwd ?? process.cwd()
  const homeDir = options.homeDir
  const compression = options.compression ?? 'zstd'
  const sessionId = options.sessionId ?? newSessionId()

  // Adapter injectado tem precedência (testes/offline); senão exige a chave.
  let adapter: LlmAdapter
  if (options.adapter) {
    adapter = options.adapter
  } else {
    const apiKey = options.apiKey ?? process.env.DEEPSEEK_API_KEY ?? ''
    if (!apiKey) {
      throw new Error('missing DeepSeek API key (set DEEPSEEK_API_KEY or pass apiKey)')
    }
    adapter = new DeepSeekAdapter({ apiKey, defaultModel: model })
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
