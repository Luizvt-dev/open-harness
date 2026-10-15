import type { FetchLike, LlmAdapter } from '@open-harness/dsh-llm'
import {
  BUILTIN_PROVIDERS,
  BUILTIN_PROVIDER_IDS,
  DEFAULT_MODEL_REF,
  DEFAULT_PROVIDER_ID,
} from './catalog.js'
import { createProviderAdapter } from './create.js'
import { MissingApiKeyError, ProviderDisabledError, UnknownModelError, UnknownProviderError } from './errors.js'
import { formatModelRef, parseModelRef } from './ref.js'
import { processEnv, resolveFirstSecret, type EnvLike } from './secrets.js'
import type {
  ApiKeySpec,
  ModelConfig,
  ModelInfo,
  ModelListing,
  ModelRef,
  ProviderApi,
  ProviderConfig,
  ProviderSummary,
  ResolvedModel,
  ResolvedProvider,
} from './types.js'
import { UNKNOWN_MODEL_CONTEXT_WINDOW, UNKNOWN_MODEL_MAX_TOKENS } from './types.js'

/** Protocolo assumido quando nem o perfil nem o catálogo embutido dizem. */
const DEFAULT_API: ProviderApi = 'openai-compatible'

export interface ProviderRegistryOptions {
  /** Ambiente usado para resolver `{ env: VAR }` (default: `process.env`). */
  env?: EnvLike
  /** Transporte injectável (testes). */
  fetch?: FetchLike
  /** Provedores declarados no arranque. */
  providers?: Record<string, ProviderConfig>
  /** Incluir o catálogo embutido (default `true`). */
  includeBuiltin?: boolean
}

/**
 * Registry de provedores LLM.
 *
 * Junta três camadas — catálogo embutido, configuração do perfil e ambiente —
 * numa visão única de onde está cada modelo e que adapter fala com ele. É o
 * equivalente ao `provider:` do OpenCode, incluindo a resolução da chave a
 * partir de `{ env: VAR }`.
 */
export class ProviderRegistry {
  private readonly configs = new Map<string, ProviderConfig>()
  private readonly env: EnvLike
  private readonly fetchImpl: FetchLike | undefined
  private readonly includeBuiltin: boolean
  private cache: Map<string, ResolvedProvider> | null = null

  constructor(options: ProviderRegistryOptions = {}) {
    this.env = options.env ?? processEnv()
    this.fetchImpl = options.fetch
    this.includeBuiltin = options.includeBuiltin ?? true
    if (options.providers) this.configure(options.providers)
  }

  /** Funde configuração de provedores (idempotente; chamado por camadas). */
  configure(configs: Record<string, ProviderConfig>): this {
    for (const [id, config] of Object.entries(configs)) {
      this.configs.set(id, { ...this.configs.get(id), ...config })
      this.cache = null
    }
    return this
  }

  /** Ids de provedores conhecidos (catálogo embutido + configurados). */
  ids(): string[] {
    return [...this.table().keys()]
  }

  /** Provedor resolvido ou `null`. */
  get(id: string): ResolvedProvider | null {
    return this.table().get(id) ?? null
  }

  /** A referência resolve para um modelo? (não lança) */
  has(ref: string | ModelRef): boolean {
    try {
      this.resolve(ref)
      return true
    } catch {
      return false
    }
  }

  /**
   * Resolve uma referência `provedor/modelo` num provedor e metadados.
   *
   * Modelos fora do catálogo são aceites por omissão com defaults
   * conservadores (o próprio endpoint diz se existem); com `strict: true`
   * no provedor, falham cedo com a lista dos que existem.
   */
  resolve(ref: string | ModelRef): ResolvedModel {
    const parsed = typeof ref === 'string' ? parseModelRef(ref, { defaultProvider: DEFAULT_PROVIDER_ID }) : ref
    const table = this.table()
    const provider = table.get(parsed.provider)
    if (!provider) throw new UnknownProviderError(parsed.provider, [...table.keys()])
    if (!provider.enabled) throw new ProviderDisabledError(parsed.provider)
    const known = provider.models.get(parsed.model)
    if (known) return { ref: parsed, provider, model: known, known: true }
    if (provider.strict) throw new UnknownModelError(parsed.provider, parsed.model, [...provider.models.keys()])
    return {
      ref: parsed,
      provider,
      model: Object.freeze({
        id: parsed.model,
        name: parsed.model,
        contextWindow: UNKNOWN_MODEL_CONTEXT_WINDOW,
        maxTokens: UNKNOWN_MODEL_MAX_TOKENS,
      }),
      known: false,
    }
  }

  /** Referência por omissão (`provedor/modelo`). */
  defaultRef(): string {
    return DEFAULT_MODEL_REF
  }

  /** Adapter capaz de falar com o modelo referenciado. */
  adapterFor(target: string | ModelRef | ResolvedModel): LlmAdapter {
    const resolved = this.asResolved(target)
    const { provider } = resolved
    const apiKey = resolveFirstSecret(provider.apiKeySpecs, this.env)
    if (provider.apiKeySpecs.length > 0 && !apiKey) {
      throw new MissingApiKeyError(provider.id, provider.apiKeySpecs)
    }
    return createProviderAdapter(provider, {
      apiKey,
      fetch: this.fetchImpl,
      defaultModel: resolved.model.id,
    })
  }

  /** Resumo dos provedores, para a listagem (`dsh models`). */
  listProviders(): ProviderSummary[] {
    return [...this.table().values()].map((provider) => ({
      id: provider.id,
      name: provider.name,
      api: provider.api,
      baseURL: provider.baseURL,
      modelCount: provider.models.size,
      enabled: provider.enabled,
      builtin: provider.builtin,
      hasApiKey: resolveFirstSecret(provider.apiKeySpecs, this.env) !== '',
      requiresApiKey: provider.apiKeySpecs.length > 0,
    }))
  }

  /** Modelos visíveis, com filtro por provedor e por texto. */
  listModels(filter: { provider?: string; search?: string } = {}): ModelListing[] {
    const needle = filter.search?.trim().toLowerCase()
    const out: ModelListing[] = []
    for (const provider of this.table().values()) {
      if (filter.provider && provider.id !== filter.provider) continue
      if (!provider.enabled) continue
      for (const model of provider.models.values()) {
        if (needle && !`${model.id} ${model.name} ${provider.id}`.toLowerCase().includes(needle)) continue
        out.push({
          ...model,
          provider: provider.id,
          ref: formatModelRef({ provider: provider.id, model: model.id }),
          builtin: provider.builtin && !this.configs.get(provider.id)?.models?.[model.id],
        })
      }
    }
    return out
  }

  private asResolved(target: string | ModelRef | ResolvedModel): ResolvedModel {
    if (typeof target === 'object' && 'provider' in target && 'model' in target && 'ref' in target) return target
    return this.resolve(target as string | ModelRef)
  }

  private table(): Map<string, ResolvedProvider> {
    if (this.cache) return this.cache
    const ids = new Set<string>([
      ...(this.includeBuiltin ? BUILTIN_PROVIDER_IDS : []),
      ...this.configs.keys(),
    ])
    const out = new Map<string, ResolvedProvider>()
    for (const id of ids) out.set(id, this.build(id))
    this.cache = out
    return out
  }

  /** Provedor = catálogo embutido + configuração do perfil. */
  private build(id: string): ResolvedProvider {
    const builtin = BUILTIN_PROVIDERS[id]
    const config = this.configs.get(id) ?? {}
    const models = new Map<string, ModelInfo>()
    for (const [modelId, info] of Object.entries(builtin?.models ?? {})) models.set(modelId, info)
    for (const [modelId, patch] of Object.entries(config.models ?? {})) {
      models.set(modelId, mergeModel(modelId, models.get(modelId), patch))
    }
    const apiKeySpecs: ApiKeySpec[] = config.apiKey
      ? [config.apiKey]
      : (builtin?.apiKeyEnv ?? []).map((env) => ({ env }))
    const provider: ResolvedProvider = {
      id,
      name: config.name ?? builtin?.name ?? id,
      api: config.api ?? builtin?.api ?? DEFAULT_API,
      baseURL: config.baseURL ?? builtin?.baseURL ?? '',
      apiKeySpecs,
      enabled: config.enabled ?? true,
      strict: config.strict ?? false,
      models,
      builtin: builtin !== undefined,
    }
    if (config.apiKey !== undefined) provider.apiKey = config.apiKey
    if (config.headers !== undefined) provider.headers = config.headers
    return provider
  }
}

/** Atalho: registry com os provedores do perfil já aplicados. */
export function createProviderRegistry(options: ProviderRegistryOptions = {}): ProviderRegistry {
  return new ProviderRegistry(options)
}

/** Funde a entrada do catálogo com o patch do perfil, campo a campo. */
function mergeModel(id: string, base: ModelInfo | undefined, patch: ModelConfig): ModelInfo {
  return Object.freeze({
    id,
    name: patch.name ?? base?.name ?? id,
    contextWindow: patch.contextWindow ?? base?.contextWindow ?? UNKNOWN_MODEL_CONTEXT_WINDOW,
    maxTokens: patch.maxTokens ?? base?.maxTokens,
    cost: patch.cost ?? base?.cost,
    input: patch.input ?? base?.input,
    output: patch.output ?? base?.output,
    toolCall: patch.toolCall ?? base?.toolCall,
    reasoning: patch.reasoning ?? base?.reasoning,
    attachment: patch.attachment ?? base?.attachment,
    temperature: patch.temperature ?? base?.temperature,
    releaseDate: patch.releaseDate ?? base?.releaseDate,
  })
}
