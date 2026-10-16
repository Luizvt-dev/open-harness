// ---------------------------------------------------------------------------
// Testes do plugin `ui-conversation`.
//
// O slot é por substituição: se o item do plugin não contiver o item por
// omissão do shell, o ecrã muda de aspecto no momento em que o plugin
// carrega. Daí os dois testes seguintes — paridade do HTML e, com o plugin
// registado, o `ConversationItem` a desenhar exactamente este componente.
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SlotProvider, SlotRegistry } from '@open-harness/dsh-client-ui-slots'
import { ConversationItem, itemSlot, type Message } from '@open-harness/dsh-web-frontend'
import { ASSISTANT_SLOT, AssistantItem, install } from '@open-harness/dsh-client-ui-conversation'

const SOURCE_DIR = fileURLToPath(new URL('../src/', import.meta.url))

/** Mensagem do tipo `assistant`. */
const assistant = (text: string): Message => ({ kind: 'assistant', text })

/** Desenha uma entrada da conversa com um registo dado (vazio = versão do shell). */
function renderConversationItem(message: Message, registry: SlotRegistry = new SlotRegistry()): string {
  return renderToStaticMarkup(
    createElement(
      SlotProvider,
      { registry },
      createElement(ConversationItem, { message }),
    ),
  )
}

describe('campo dsh.client do package.json', () => {
  it('declara entrada, slots e ordem', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      dsh?: { client?: { entry?: string; slots?: string[]; order?: number } }
    }
    const client = pkg.dsh?.client
    expect(client?.entry).toBe('./dist/index.js')
    expect(client?.slots).toEqual([ASSISTANT_SLOT])
    expect(ASSISTANT_SLOT).toBe('chat.item.assistant')
    expect(ASSISTANT_SLOT).toBe(itemSlot(assistant('')))
    // Depois dos plugins estruturais (tema), antes das linhas de tool.
    expect(client?.order).toBe(150)
  })
})

describe('entrada do navegador', () => {
  it('não importa builtins de Node (corre no navegador)', () => {
    const offenders = readdirSync(SOURCE_DIR)
      .filter((file) => file.endsWith('.ts') || file.endsWith('.tsx'))
      .filter((file) =>
        /from ['"]node:|import ['"]node:/.test(readFileSync(join(SOURCE_DIR, file), 'utf8')),
      )
    expect(offenders).toEqual([])
  })
})

describe('install', () => {
  it('substitui o item do agente no slot certo', () => {
    const registry = new SlotRegistry()
    install(registry)

    expect(registry.slots()).toEqual([ASSISTANT_SLOT])
    const entries = registry.list(ASSISTANT_SLOT)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.id).toBe('assistant')
    expect(entries[0]?.component).toBe(AssistantItem)
  })

  it('é idempotente (o HMR volta a chamar o mesmo install)', () => {
    const registry = new SlotRegistry()
    install(registry)
    install(registry)
    expect(registry.list(ASSISTANT_SLOT)).toHaveLength(1)
  })
})

describe('AssistantItem', () => {
  it('renderiza em Node sem browser', () => {
    const html = renderToStaticMarkup(createElement(AssistantItem, { message: assistant('olá') }))
    expect(html).toContain('class="msg msg--assistant"')
    expect(html).toContain('agente')
    expect(html).toContain('olá')
    expect(html).toContain('copiar resposta')
  })

  it('devolve nada em mensagens de outro tipo', () => {
    const html = renderToStaticMarkup(
      createElement(AssistantItem, { message: { kind: 'user', text: 'tu' } }),
    )
    expect(html).toBe('')
  })

  it('paridade com o item por omissão do shell: acrescenta, não substitui', () => {
    const message = assistant('uma resposta com <verbatim>')
    const shell = renderConversationItem(message)
    const plugin = renderToStaticMarkup(createElement(AssistantItem, { message }))

    // O item do plugin é o do shell com uma linha de acções no fim, por isso
    // coincide até ao `</div>` que fecha a bolha — só esse é que fica para
    // trás (é ele que a linha de acções empurra para depois).
    const shellBody = shell.slice(0, shell.lastIndexOf('</div>'))
    expect(shellBody.length).toBeGreaterThan(0)
    expect(plugin.startsWith(shellBody)).toBe(true)
    expect(plugin.length).toBeGreaterThan(shell.length)
  })
})

describe('ConversationItem com o plugin instalado', () => {
  it('o shell passa a desenhar o item do plugin', () => {
    const registry = new SlotRegistry()
    install(registry)
    const html = renderConversationItem(assistant('olá'), registry)

    expect(html).toContain('copiar resposta')
    expect(html).toContain('class="msg-actions"')
  })
})
