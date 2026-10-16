// ---------------------------------------------------------------------------
// Testes do plugin `ui-tool`.
//
// A linha de tool é a que mais muda durante um turno (a correr → ok/erro), e
// por isso a paridade aqui é verificada em três estados: a correr, com
// sucesso e com falha — em todos eles o HTML tem de ser o do shell com a
// linha de acções acrescentada.
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SlotProvider, SlotRegistry } from '@open-harness/dsh-client-ui-slots'
import { ConversationItem, itemSlot, type Message } from '@open-harness/dsh-web-frontend'
import { TOOL_SLOT, ToolRowItem, install } from '@open-harness/dsh-client-ui-tool'

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

/** Os três estados de uma tool, do mais curto ao mais completo. */
const TOOLS = [
  { kind: 'tool', id: 'a', name: 'bash' },
  { kind: 'tool', id: 'b', name: 'bash', ok: true, durationMs: 42, output: 'feito' },
  { kind: 'tool', id: 'c', name: 'fs.read', ok: false, durationMs: 7, output: 'sem acesso' },
] as unknown as Message[]

describe('campo dsh.client do package.json', () => {
  it('declara entrada, slot e ordem', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      dsh?: { client?: { entry?: string; slots?: string[]; order?: number } }
    }
    const client = pkg.dsh?.client
    expect(client?.entry).toBe('./dist/index.js')
    expect(client?.slots).toEqual([TOOL_SLOT])
    expect(TOOL_SLOT).toBe('chat.item.tool')
    expect(TOOL_SLOT).toBe(itemSlot({ kind: 'tool', id: '', name: '' }))
    // Por último: as linhas de tool são o fim de um turno.
    expect(client?.order).toBe(200)
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
  it('substitui a linha de tool no slot certo', () => {
    const registry = new SlotRegistry()
    install(registry)

    expect(registry.slots()).toEqual([TOOL_SLOT])
    const entries = registry.list(TOOL_SLOT)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.id).toBe('tool-row')
    expect(entries[0]?.component).toBe(ToolRowItem)
  })

  it('é idempotente (o HMR volta a chamar o mesmo install)', () => {
    const registry = new SlotRegistry()
    install(registry)
    install(registry)
    expect(registry.list(TOOL_SLOT)).toHaveLength(1)
  })
})

describe('ToolRowItem', () => {
  it('mantém o `<details>` e o estado do shell nos três estados', () => {
    const [running, ok, failed] = TOOLS.map((message) =>
      renderToStaticMarkup(createElement(ToolRowItem, { message })),
    )

    expect(running).toContain('class="ferramenta ferramenta--running"')
    expect(running).toContain('a correr…')
    expect(ok).toContain('class="ferramenta ferramenta--ok"')
    expect(ok).toContain('ok · 42 ms')
    expect(failed).toContain('class="ferramenta ferramenta--fail"')
    expect(failed).toContain('erro · 7 ms')
    expect(failed).toContain('fs.read')
  })

  it('acrescenta o copiar à saída — e nada quando não há saída', () => {
    const [running, ok] = TOOLS.map((message) =>
      renderToStaticMarkup(createElement(ToolRowItem, { message })),
    )
    expect(ok).toContain('copiar saída')
    expect(ok).toContain('feito')
    // Sem output não há o que copiar: a linha de acções não aparece.
    expect(running).not.toContain('copiar')
    expect(running).not.toContain('msg-actions')
  })

  it('devolve nada em mensagens de outro tipo', () => {
    const html = renderToStaticMarkup(
      createElement(ToolRowItem, { message: { kind: 'user', text: 'tu' } }),
    )
    expect(html).toBe('')
  })

  it('paridade com o item por omissão do shell, nos três estados', () => {
    for (const message of TOOLS) {
      const shell = renderConversationItem(message)
      const plugin = renderToStaticMarkup(createElement(ToolRowItem, { message }))
      // O item do plugin é o do shell com uma linha de acções antes de fechar
      // o `<details>` — coincide tudo até aí.
      const shellBody = shell.slice(0, shell.lastIndexOf('</details>'))
      expect(shellBody.length).toBeGreaterThan(0)
      expect(plugin.startsWith(shellBody)).toBe(true)
    }
  })
})

describe('ConversationItem com o plugin instalado', () => {
  it('o shell passa a desenhar a linha do plugin', () => {
    const registry = new SlotRegistry()
    install(registry)
    const html = renderConversationItem(TOOLS[1] as Message, registry)

    expect(html).toContain('copiar saída')
    expect(html).toContain('class="msg-actions"')
  })
})
