// Público do dsh-agent: serviço e plugin cordis do agente.
export * from './service.js'
export {
  apply,
  plugin,
  LLM_ADAPTER_SERVICE,
  TOOLS_SERVICE,
  type Agent,
} from './plugin.js'
// `default` é o que o `cordis-plugin-loader` desembrulha primeiro — é ele que
// transporta o `inject` da plugin (o namespace nomeado não o copiaria).
export { default } from './plugin.js'
