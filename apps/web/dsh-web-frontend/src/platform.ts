// ---------------------------------------------------------------------------
// Entrada Node do shell: onde o React está no disco.
//
// O shell não é compilado nem embutido — o host serve os shims ESM da pasta
// `platform/` e os UMD do próprio `node_modules`, e o navegador liga os dois
// pelo import map. Este módulo diz ao host QUEM é QUEM, para que a resolução
// do vendor aconteça no contexto deste pacote (aqui `react` é dependência
// directa) e não no da app, que no pnpm estrito nem sequer o vê.
//
// Não importa nada de DOM: é chamado de `apps/dsh` para montar as rotas.
// ---------------------------------------------------------------------------

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PlatformModules } from '@open-harness/dsh-client-modules'

/** Directório do `dist` deste pacote (onde este módulo é compilado). */
function distDir(): string {
  return dirname(fileURLToPath(import.meta.url))
}

/** Directório com os shims ESM (`platform/*.js`), tal como saem do repositório. */
export function shimDir(): string {
  return join(distDir(), '..', 'platform')
}

/**
 * Directório `umd` de um pacote resolvido a partir daqui.
 *
 * `import.meta.resolve(specifier)` segue a `exports` map do pacote, por isso
 * resolve a entrada raiz (`index.js`); o `umd/` vive ao lado. Caminho no disco,
 * não subpath de exports — nada o bloqueia.
 */
function umdDirOf(specifier: string): string {
  return join(dirname(fileURLToPath(import.meta.resolve(specifier))), 'umd')
}

/** Um ficheiro servido em `/platform/…`. */
export interface PlatformFile {
  /** Directório raiz (para `serveStatic`). */
  root: string
  /** Caminho relativo dentro de `root`. */
  file: string
}

/**
 * Mapa de `/platform/<caminho>` para o ficheiro no disco.
 *
 * Os shims são estáveis (nomes nossos); o vendor usa nomes de versão estáveis
 * (`react.umd.js`) por cima dos ficheiros minificados do React, para que uma
 * actualização de `react` não mude as URLs do import map.
 */
export function platformFiles(): Map<string, PlatformFile> {
  const shims: PlatformFile = { root: shimDir(), file: '' }
  const files = new Map<string, PlatformFile>([
    ['react.js', { ...shims, file: 'react.js' }],
    ['react-dom.js', { ...shims, file: 'react-dom.js' }],
    ['react-dom-client.js', { ...shims, file: 'react-dom-client.js' }],
    ['react-jsx-runtime.js', { ...shims, file: 'react-jsx-runtime.js' }],
    ['react.umd.js', { root: umdDirOf('react'), file: 'react.production.min.js' }],
    ['react-dom.umd.js', { root: umdDirOf('react-dom'), file: 'react-dom.production.min.js' }],
  ])
  return files
}

/**
 * Tabela de módulos de plataforma para o manifesto de boot.
 *
 * São os especificadores que o shell e os plugins `ui-*` usam; o host mete-as
 * em `window.__DSH_BOOT__.platform` e o `index.html` transforma-as no import
 * map da página. As entradas `@open-harness/*` do workspace são acrescentadas
 * pelo host (ficam em `web-plugin.ts`, ao lado das rotas que as servem).
 */
export function platformModules(): PlatformModules {
  return {
    react: '/platform/react.js',
    'react-dom': '/platform/react-dom.js',
    'react-dom/client': '/platform/react-dom-client.js',
    'react/jsx-runtime': '/platform/react-jsx-runtime.js',
  }
}
