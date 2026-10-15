// Público do dsh-llm-deepseek: adapter DeepSeek (API Anthropic-like).
// O parser SSE vive no `dsh-llm` (é transporte comum); re-exportamo-lo para
// não quebrar quem já importava daqui.
export * from './models.js'
export { SseParser, type SseEvent, type FetchLike } from '@open-harness/dsh-llm'
export * from './adapter.js'
