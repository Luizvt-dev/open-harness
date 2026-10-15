import { resolve } from 'node:path'
import { Context } from '@open-harness/cordis'
import { bootApp } from '@open-harness/app-boot'
import { AGENT_SERVICE, LLM_ADAPTER_SERVICE, type AgentService } from '@open-harness/dsh-agent'
import type { TurnOutcome } from '@open-harness/dsh-agent-loop'
import type { LlmAdapter } from '@open-harness/dsh-llm'
import { resolveDshHome } from '@open-harness/home-paths'
import { ensureProfile, writeRuntimeOverlay, type RuntimeOverrides } from './profile.js'

/** Opções de um turno único executado pela CLI. */
export interface RunOptions extends RuntimeOverrides {
  /** Mensagem do utilizador. */
  prompt: string
  /** Nome do perfil (default `headless`). */
  profile?: string
  /** Home de dados; por omissão `resolveDshHome()`. */
  homeDir?: string
  /** Adapter LLM injectado (modo offline / testes); sem ele usa DeepSeek. */
  adapter?: LlmAdapter
  /** Cancelamento (SIGINT na CLI). */
  signal?: AbortSignal
  /** Observabilidade: chamado com o boot pronto antes do turno. */
  onBoot?: (ctx: Context) => void
}

/** Resultado de `runPrompt`. */
export interface RunResult {
  outcome: TurnOutcome
  /** Caminho canónico do `session.v4.jsonl[.zstd]`. */
  sessionPath: string
  profileDir: string
  /** Nome do perfil efectivamente arrancado. */
  profile: string
}

/**
 * Caminho de arranque da CLI `dsh`:
 *
 * 1. materializa/valida o perfil (`headless` é gerado pela CLI);
 * 2. escreve o overlay de runtime com as sobrescritas da linha de comandos;
 * 3. cria o `Context` raiz (e injeta um adapter LLM, se houver);
 * 4. `bootApp` → compõe `bundles → perfil → home → overlay` e aplica no cordis;
 * 5. resolve o serviço `agent` e corre um turno, que persiste a sessão;
 * 6. descarrega o boot (`shutdown`) — sempre, mesmo em erro.
 */
export async function runPrompt(options: RunOptions): Promise<RunResult> {
  const profile = options.profile ?? 'headless'
  const home = resolve(options.homeDir ?? resolveDshHome())

  const { profileDir } = ensureProfile({ homeDir: home, name: profile })
  const overlay = writeRuntimeOverlay(home, {
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.system !== undefined ? { system: options.system } : {}),
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
  })

  const ctx = new Context()
  if (options.adapter) ctx.set(LLM_ADAPTER_SERVICE, options.adapter)

  const boot = await bootApp({
    ctx,
    profileDir,
    homeDir: home,
    overlays: [overlay],
    onRowError: 'strict',
  })

  try {
    options.onBoot?.(ctx)
    const agent = ctx.get<AgentService>(AGENT_SERVICE)
    const outcome = await agent.run(options.prompt, options.signal)
    return { outcome, sessionPath: agent.sessionPath, profileDir, profile }
  } finally {
    await boot.shutdown()
  }
}
