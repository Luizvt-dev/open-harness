// ---------------------------------------------------------------------------
// Botão "copiar" — afordância dos slots `chat.item.*`.
//
// Vive no shell (e não em cada plugin) porque o estilo é do shell: um plugin
// que acrescente "copiar" a um item tem de parecer parte da mesma UI, e três
// plugins com o seu próprio botão é três botões a divergir.
//
// A UI por omissão não o desenha — a vanilla não tinha — por isso isto é
// material para plugins, não uma mudança do shell.
// ---------------------------------------------------------------------------

import { useState, type ReactNode } from 'react'

/** Estado visual do botão. */
type CopyState = 'idle' | 'done' | 'fail'

/**
 * Copia texto para a área de transferência.
 *
 * Tenta primeiro o clipboard assíncrono (a via certa) e, se falhar — contextos
 * não-seguros não o expõem, um iframe sem permissão ou um documento sem foco
 * — cai para a selecção temporária com `execCommand`. Devolve `false` quando
 * nada disto dá: o botão mostra o falhanço em vez de fingir que copiou.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    const clipboard = globalThis.navigator?.clipboard
    if (clipboard) {
      await clipboard.writeText(text)
      return true
    }
  } catch {
    // Sem permissão / sem foco: tenta a via antiga antes de desistir.
  }
  return legacyCopy(text)
}

/**
 * Fallback legado: mete o texto numa `textarea` invisível, selecciona e copia.
 *
 * `execCommand` está deprecado, mas continua a ser o único caminho que existe
 * fora de contexto seguro — e é síncrono, por isso funciona até onde o
 * assíncrono não chega.
 */
function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined') return false
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.top = '0'
    area.style.opacity = '0'
    document.body?.appendChild(area)
    area.select()
    const copied = document.execCommand('copy')
    area.remove()
    return copied
  } catch {
    return false
  }
}

/**
 * Botão de copiar com feedback inline.
 *
 * `className` vem de quem o usa (o shell define `msg-copy` em `style.css` e os
 * estados `--done`/`--fail`), `label` é o texto em repouso.
 */
export function CopyButton(props: { text: string; label: string; className: string }): ReactNode {
  const [state, setState] = useState<CopyState>('idle')
  const label = state === 'done' ? 'copiado' : state === 'fail' ? 'falhou' : props.label
  const className =
    state === 'idle' ? props.className : `${props.className} ${props.className}--${state}`

  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        void copyText(props.text).then((ok) => {
          setState(ok ? 'done' : 'fail')
          // Volta ao rótulo inicial: o estado é feedback, não memória.
          setTimeout(() => setState('idle'), 1600)
        })
      }}
    >
      {label}
    </button>
  )
}
