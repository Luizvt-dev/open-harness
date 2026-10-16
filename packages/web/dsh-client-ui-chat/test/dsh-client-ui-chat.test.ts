// ---------------------------------------------------------------------------
// Testes do plugin `ui-chat`.
//
// Este plugin ocupa DOIS slots com o mesmo componente, por isso os testes
// cobrem as duas bolhas e a paridade de cada uma face ao item por omissão do
// shell — o `user` e o `error` têm papéis e class names diferentes.
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SlotProvider, SlotRegistry } from '@open-harness/dsh-client-ui-slots'
import { ConversationItem, itemSlot, type Message } from '@open-harness/dsh-web-frontend'
import {
  ChatItem,
  ERROR_SLOT,
  USER_SLOT,
  install,
} from '@open-harness/dsh-client-ui-chat'

const SOURCE_DIR = fileURLToPath(new URL('../src/', import.meta.url))

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
  it('declara entrada, os dois slots e ordem', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      dsh?: { client?: { entry?: string; slots?: string[]; order?: number } }
    }
    const client = pkg.dsh?.client
    expect(client?.entry).toBe('./dist/index.js')
    expect(client?.slots).toEqual([USER_SLOT, ERROR_SLOT])
    expect(USER_SLOT).toBe('chat.item.user')
    expect(ERROR_SLOT).toBe('chat.item.error')
    expect([USER_SLOT, ERROR_SLOT]).toEqual([
      itemSlot({ kind: 'user', text: '' }),
      itemSlot({ kind: 'error', text: '' }),
    ])
    // Depois das bolhas do agente, antes das linhas de tool.
    expect(client?.order).toBe(160)
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
  it('substitui as duas bolhas com o mesmo componente', () => {
    const registry = new SlotRegistry()
    install(registry)

    // `slots()` devolve ordenado, por isso compara-se como conjunto.
    expect(registry.slots().slice().sort()).toEqual([USER_SLOT, ERROR_SLOT].slice().sort())
    for (const slot of [USER_SLOT, ERROR_SLOT]) {
      const entries = registry.list(slot)
      expect(entries).toHaveLength(1)
      expect(entries[0]?.id).toBe('chat-item')
      expect(entries[0]?.component).toBe(ChatItem)
    }
  })

  it('é idempotente (o HMR volta a chamar o mesmo install)', () => {
    const registry = new SlotRegistry()
    install(registry)
    install(registry)
    expect(registry.list(USER_SLOT)).toHaveLength(1)
    expect(registry.list(ERROR_SLOT)).toHaveLength(1)
  })
})

describe('ChatItem', () => {
  it('desenha a bolha do utilizador com o papel certo', () => {
    const html = renderToStaticMarkup(
      createElement(ChatItem, { message: { kind: 'user', text: 'olá' } }),
    )
    expect(html).toContain('class="msg msg--user"')
    expect(html).toContain('tu</div>')
    expect(html).toContain('copiar mensagem')
  })

  it('desenha a bolha de erro com o papel certo', () => {
    const html = renderToStaticMarkup(
      createElement(ChatItem, { message: { kind: 'error', text: 'falhou' } }),
    )
    expect(html).toContain('class="msg msg--error"')
    expect(html).toContain('erro</div>')
    expect(html).toContain('copiar erro')
  })

  it('devolve nada nos itens que não são seus', () => {
    for (const message of [
      { kind: 'assistant', text: 'x' },
      { kind: 'tool', id: 't', name: 'bash' },
    ] as Message[]) {
      expect(renderToStaticMarkup(createElement(ChatItem, { message }))).toBe('')
    }
  })

  it('paridade com o item por omissão do shell, nos dois slots', () => {
    for (const message of [
      { kind: 'user', text: 'uma mensagem com <verbatim>' },
      { kind: 'error', text: 'um erro com <verbatim>' },
    ] as Message[]) {
      const shell = renderConversationItem(message)
      const plugin = renderToStaticMarkup(createElement(ChatItem, { message }))
      // O item do plugin é o do shell com uma linha de acções no fim, por isso
      // coincide até ao `</div>` que fecha a bolha.
      const shellBody = shell.slice(0, shell.lastIndexOf('</div>'))
      expect(shellBody.length).toBeGreaterThan(0)
      expect(plugin.startsWith(shellBody)).toBe(true)
      expect(plugin.length).toBeGreaterThan(shell.length)
    }
  })
})

describe('ConversationItem com o plugin instalado', () => {
  it('o shell passa a desenhar as duas bolhas do plugin', () => {
    const registry = new SlotRegistry()
    install(registry)

    const user = renderConversationItem({ kind: 'user', text: 'olá' }, registry)
    expect(user).toContain('copiar mensagem')

    const error = renderConversationItem({ kind: 'error', text: 'falhou' }, registry)
    expect(error).toContain('copiar erro')

    // E o item do agente continua no shell (outro plugin, outro slot).
    const assistant = renderConversationItem({ kind: 'assistant', text: 'resposta' }, registry)
    expect(assistant).not.toContain('copiar')
  })
})
