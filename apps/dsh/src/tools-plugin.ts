import type { Context } from '@open-harness/cordis'
import { AGENT_SERVICE, type AgentService } from '@open-harness/dsh-agent'
import { defaultCliTools } from './tools.js'

/** Configuração da plugin (camada do bundle/perfil). */
export interface CliToolsConfig {
  /** Whitelist de nomes — se presente, só estas tools são registadas. */
  only?: string[]
}

/**
 * Regista as tools da CLI (`read`/`write`/`edit`, `glob`/`grep`, `bash`)
 * no `ToolRegistry` do serviço `agent`.
 *
 * A dependência de `agent` é declarada **duas vezes de propósito**:
 * - `requires: ['agent']` na linha do bundle (a que o loader realmente usa);
 * - `inject` aqui, para o caso de o módulo ser desembrulhado como função.
 *
 * Sem isto as duas linhas correriam em paralelo (`runAll` usa `Promise.all`)
 * e esta poderia aplicar-se antes de o serviço existir.
 */
const plugin = {
  inject: [AGENT_SERVICE],
  apply(ctx: Context, config: CliToolsConfig = {}): void {
    const agent = ctx.get<AgentService>(AGENT_SERVICE)
    const allow = Array.isArray(config.only) ? new Set(config.only) : null

    for (const def of defaultCliTools()) {
      if (allow && !allow.has(def.name)) continue
      if (!agent.tools.has(def.name)) agent.tools.register(def)
    }
  },
}

export const apply = plugin.apply
export default plugin
