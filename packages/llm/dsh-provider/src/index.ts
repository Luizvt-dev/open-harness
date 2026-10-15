// Público do dsh-provider: registry de provedores LLM, catálogo de modelos,
// referências `provedor/modelo` e adapters por protocolo.
export * from './types.js'
export * from './ref.js'
export * from './errors.js'
export * from './secrets.js'
export * from './catalog.js'
export * from './registry.js'
export * from './create.js'
export * from './adapters/openai.js'
export * from './adapters/google.js'
