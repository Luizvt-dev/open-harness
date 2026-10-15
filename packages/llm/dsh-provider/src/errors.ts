import type { ApiKeySpec } from './types.js'

/** Erro base do sistema de provedores. */
export class ProviderError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'ProviderError'
  }
}

/** A referência aponta para um provedor que não está declarado nem no catálogo. */
export class UnknownProviderError extends ProviderError {
  constructor(readonly providerId: string, readonly known: readonly string[]) {
    super(
      `unknown provider "${providerId}" (known: ${known.length ? known.join(', ') : 'none'})`,
      'unknown-provider',
    )
    this.name = 'UnknownProviderError'
  }
}

/** Provedor existe mas o modelo não está no catálogo e o provedor é estrito. */
export class UnknownModelError extends ProviderError {
  constructor(
    readonly providerId: string,
    readonly modelId: string,
    readonly known: readonly string[],
  ) {
    super(
      `unknown model "${modelId}" for provider "${providerId}" ` +
        `(known: ${known.length ? known.join(', ') : 'none'})`,
      'unknown-model',
    )
    this.name = 'UnknownModelError'
  }
}

/** O provedor está declarado mas desactivado. */
export class ProviderDisabledError extends ProviderError {
  constructor(readonly providerId: string) {
    super(`provider "${providerId}" is disabled`, 'provider-disabled')
    this.name = 'ProviderDisabledError'
  }
}

/** O provedor exige chave e nenhuma das especificações resolveu. */
export class MissingApiKeyError extends ProviderError {
  constructor(readonly providerId: string, readonly specs: readonly ApiKeySpec[]) {
    super(
      `missing API key for provider "${providerId}" ` +
        `(set ${specs.map(describeSpec).join(' or ')})`,
      'missing-api-key',
    )
    this.name = 'MissingApiKeyError'
  }
}

function describeSpec(spec: ApiKeySpec): string {
  if (typeof spec === 'string') return '<inline key>'
  if ('env' in spec) return spec.env
  return `file ${spec.file}`
}
