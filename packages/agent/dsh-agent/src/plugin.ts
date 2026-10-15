import type { Context } from '@open-harness/cordis'
import type { LlmAdapter } from '@open-harness/dsh-llm'
import type { ToolRegistry } from '@open-harness/dsh-tools'
import {
  AGENT_SERVICE,
  createAgentService,
  type AgentService,
  type AgentServiceConfig,
} from './service.js'

export { AGENT_SERVICE, createAgentService }
export type { AgentService, AgentServiceConfig }

/** API pública do serviço `agent` — o que outros plugins injectam. */
export type { AgentService as Agent }

/**
 * Nome do serviço opcional que fornece um `LlmAdapter` pronto a usar.
 *
 * Permite ao arranque (CLI, testes) injectar um transporte sem depender de
 * configuração YAML: cria-se `ctx.set(LLM_ADAPTER_SERVICE, adapter)` **antes**
 * do `bootApp`, e o plugin do agente usa-o em vez de resolver um adapter no
 * registry de provedores.
 */
export const LLM_ADAPTER_SERVICE = 'llm-adapter'

/** Nome do serviço opcional com um `ToolRegistry` partilhado. */
export const TOOLS_SERVICE = 'tools'

/**
 * Publica o serviço `agent` no cordis.
 *
 * - `tools?` (opcional): se outro plugin já registou um `ToolRegistry`, as
 *   tools são herdadas; senão fica vazio (o bundle headless acrescenta as suas).
 * - `llm-adapter?` (opcional): transporte LLM injectado pelo arranque; sem ele
 *   resolve-se o adapter pelo registry de provedores (`providers` + catálogo
 *   embutido) usando `model` como referência `provedor/modelo`.
 *
 * A criação do serviço é **lazily** (na primeira chamada a `get('agent')` ou
 * a um dos seus membros), para que a ausência de API key não rebente no boot —
 * falha só quando alguém tenta usar o agente.
 */
export const plugin = {
  // Objecto (não array): a forma array marca tudo como *required*.
  inject: { required: [], optional: [TOOLS_SERVICE, LLM_ADAPTER_SERVICE] },
  apply(ctx: Context, config: AgentServiceConfig = {}): void {
    let instance: AgentService | null = null
    const ensure = (): AgentService => {
      if (!instance) {
        // Serviços lidos aqui (e não no `apply`) para não depender da ordem em
        // que ficam disponíveis — `tools`/`llm-adapter` podem chegar depois.
        const inherited = ctx.has(TOOLS_SERVICE) ? ctx.get<ToolRegistry>(TOOLS_SERVICE) : undefined
        const injectedAdapter = ctx.has(LLM_ADAPTER_SERVICE)
          ? ctx.get<LlmAdapter>(LLM_ADAPTER_SERVICE)
          : undefined

        instance = createAgentService({
          ...config,
          ...(injectedAdapter ? { adapter: injectedAdapter } : {}),
        })
        if (inherited) {
          for (const name of inherited.names()) {
            const def = inherited.get(name)
            if (def && !instance.tools.has(name)) instance.tools.register(def)
          }
        }
      }
      return instance
    }

    const lazy: AgentService = {
      get session() {
        return ensure().session
      },
      get tools() {
        return ensure().tools
      },
      get loop() {
        return ensure().loop
      },
      get registry() {
        return ensure().registry
      },
      get modelRef() {
        return ensure().modelRef
      },
      get model() {
        return ensure().model
      },
      get sessionPath() {
        return ensure().sessionPath
      },
      run(prompt, signal) {
        return ensure().run(prompt, signal)
      },
    }

    ctx.set(AGENT_SERVICE, lazy)
  },
}

export const apply = plugin.apply
export default plugin
