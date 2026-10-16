// ---------------------------------------------------------------------------
// Entrada do shell no navegador.
//
// Corre uma vez, depois do `index.html` ter: gravado o cookie, carregado o
// manifesto (`/__dsh_boot__.js`), carregado os UMD do React e injectado o
// import map. Daqui em diante `react` é um specifier normal.
//
// A ordem importa: o shell monta PRIMEIRO (com as slots por omissão) e só
// depois carrega os plugins. Os slots são reactivos, por isso a inscrição de
// um plugin actualiza o ecrã sem re-render à mão — e um plugin que demore não
// atrasa a primeira pintura.
// ---------------------------------------------------------------------------

import { createRoot } from 'react-dom/client'
import { createClient } from '@open-harness/dsh-client-connection'
import { SlotProvider } from '@open-harness/dsh-client-ui-slots'
import { createLoader } from '@open-harness/dsh-client-modules/browser'
import { Shell } from './shell.js'
import { shellRegistry } from './registry.js'
import { installPlugins } from './plugin.js'

/** Globals que o `index.html` grava antes de importar este módulo. */
interface BootScope {
  __DSH_TOKEN__?: string
  __DSH_SHOW_ERROR__?: (message: string) => void
}

/**
 * Carrega os plugins do manifesto e deixa cada um inscrever-se nos slots.
 *
 * Falhar aqui não pode derrubar a interface: sem plugins o shell desenha a
 * UI por omissão, que é exactamente o estado pré-D3. O loader recebe
 * `head: null` porque o import map da página já existe (o `index.html`
 * construiu-o a partir do mesmo manifesto) — injetar outro daria dois
 * `<script type="importmap">`, que os browsers recusam.
 */
async function loadUiPlugins(): Promise<void> {
  try {
    const loader = createLoader({ head: null })
    const modules = await loader.loadCombo()
    installPlugins(modules.values(), shellRegistry)
  } catch (failure) {
    console.error('[dsh] falha ao carregar plugins de UI:', failure)
  }
}

function bootstrap(): void {
  const scope = globalThis as BootScope
  const root = document.getElementById('root')
  if (!root) return

  const token = scope.__DSH_TOKEN__ ?? ''
  if (!token) {
    // O `index.html` já mostrou o aviso; aqui só nos garantimos que não
    // montamos uma UI que ia receber 401 em toda a parte.
    scope.__DSH_SHOW_ERROR__?.(
      'Sem token de acesso. Reabra a UI pela URL que o dsh web imprimiu, com ?access_token=…',
    )
    return
  }

  const client = createClient({ url: location.origin, token })
  createRoot(root).render(
    <SlotProvider registry={shellRegistry}>
      <Shell client={client} />
    </SlotProvider>,
  )
  void loadUiPlugins()
}

bootstrap()
