// ---------------------------------------------------------------------------
// Contrato dos plugins de UI (`ui-*`).
//
// O shell não conhece nenhum plugin: importa-os pelo manifesto
// (`dsh-client-modules`) e, se o módulo exportar `install`, chama-o com o
// registo de slots. É tudo o que um plugin precisa para aparecer no ecrã —
// ver `slots.ts` para os nomes que o shell desenha.
//
// O `install` é síncrono e corre depois do shell já estar montado: os slots
// são reactivos (`useSyncExternalStore`), por isso uma inscrição nova
// actualiza a UI sem re-render manual.
// ---------------------------------------------------------------------------

import type { SlotRegistry } from '@open-harness/dsh-client-ui-slots'

/** Módulo de um plugin de UI, como o shell o vê. */
export interface UiPlugin {
  /** Chamado pelo shell depois de o plugin ser importado. */
  install?(registry: SlotRegistry): void
}

/**
 * Chama `install` de cada módulo de plugin.
 *
 * Devolve quantos plugins efectivamente instalaram — os módulos sem `install`
 * são ignorados em vez de falharem, porque um plugin pode ser só CSS ou só
 * side effects no `document`.
 */
export function installPlugins(modules: Iterable<unknown>, registry: SlotRegistry): number {
  let installed = 0
  for (const module of modules) {
    const candidate = module as UiPlugin | null
    if (candidate && typeof candidate.install === 'function') {
      candidate.install(registry)
      installed += 1
    }
  }
  return installed
}
