import type { ModelRef } from './types.js'

/** Erro de sintaxe numa referência `provedor/modelo`. */
export class ModelRefError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ModelRefError'
  }
}

export interface ParseModelRefOptions {
  /**
   * Provedor usado quando a referência não tem `/`. Por omissão é o provedor
   * default (`deepseek`), o que mantém compatível com configs antigas que só
   * diziam `model: deepseek-flash`.
   */
  defaultProvider?: string
}

/**
 * Divide uma referência no **primeiro** `/`.
 *
 * Isto é essencial: no OpenRouter os ids de modelo contêm `/`
 * (`openrouter/anthropic/claude-sonnet-4.5` → provedor `openrouter`,
 * modelo `anthropic/claude-sonnet-4.5`).
 */
export function parseModelRef(ref: string, options: ParseModelRefOptions = {}): ModelRef {
  const trimmed = ref.trim()
  if (!trimmed) throw new ModelRefError('empty model reference')
  const slash = trimmed.indexOf('/')
  if (slash < 0) {
    if (!options.defaultProvider) {
      throw new ModelRefError(`model reference "${ref}" must be "<provider>/<model>"`)
    }
    return { provider: options.defaultProvider, model: trimmed }
  }
  const provider = trimmed.slice(0, slash)
  const model = trimmed.slice(slash + 1)
  if (!provider) throw new ModelRefError(`model reference "${ref}" has an empty provider`)
  if (!model) throw new ModelRefError(`model reference "${ref}" has an empty model`)
  return { provider, model }
}

/** Volta a juntar uma referência no formato `provedor/modelo`. */
export function formatModelRef(ref: ModelRef): string {
  return `${ref.provider}/${ref.model}`
}
