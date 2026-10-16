// ---------------------------------------------------------------------------
// `dsh-client-modules` — sistema de módulos do navegador.
//
// Duas metades, um contrato (o manifesto `__DSH_BOOT__`):
//
// - Node: descobre os `dsh.client` dos plugins habilitados, monta o manifesto
//   e serve `/plugins/<id>/client.js` + combos + source maps;
// - N browser: loader lazy que importa as entradas e injeta os módulos de
//   plataforma (React/Cordis) no import map.
//
// A entrada `.` é a metade Node. O navegador importa `./browser` (esta não
// tem `node:*`).
// ---------------------------------------------------------------------------

export type {
  BootManifest,
  ClientPlugin,
  ComboManifest,
  PlatformModules,
} from './types.js'
export {
  derivePluginId,
  readClientField,
  scanClientPlugins,
  toClientPlugin,
  type ClientField,
  type ScannedClient,
} from './scan.js'
export {
  BOOT_PATH,
  PLUGINS_PREFIX,
  createClientModuleRoutes,
  renderBootScript,
  renderComboModule,
  type ClientModuleRoutes,
  type ClientModuleRoutesOptions,
} from './serve.js'
