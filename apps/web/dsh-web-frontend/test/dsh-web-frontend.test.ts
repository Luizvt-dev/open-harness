// ---------------------------------------------------------------------------
// Testes do shell React (D2b).
//
// Três camadas, todas sem browser de propósito — e a terceira é de propósito:
//
//   1. reducer da conversa — a ordem do turno é lógica pura, e é onde os bugs
//      acontecem (uma tool a fechar a bolha de texto em curso, texto a abrir
//      outra a seguir, um erro a contar como fim de turno);
//   2. SSR do shell — `renderToStaticMarkup` não corre effects, por isso o
//      cliente falso pode registar tudo o que lhe chamarem e o teste falha se
//      o arranque tocar em rede;
//   3. slots — uma inscrição em `chat.item.*` substitui a versão por omissão
//      do shell; um slot aditivo aparece ao lado do que ele já desenha.
//
// Os componentes são criados com `createElement` para os ficheiros de teste
// ficarem `.ts`, como o resto do repositório.
// ---------------------------------------------------------------------------

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SlotProvider, SlotRegistry } from '@open-harness/dsh-client-ui-slots'
import {
  ConversationView,
  DEFAULT_ITEM_ID,
  Shell,
  SLOTS,
  appendUser,
  applyEvent,
  emptyConversation,
  fromHistory,
  installPlugins,
  itemSlot,
  turnStats,
  type Conversation,
  type HostClient,
  type Message,
} from '@open-harness/dsh-web-frontend'
import { platformFiles, platformModules } from '@open-harness/dsh-web-frontend/platform'

/** Cliente falso: qualquer chamada ao host durante o SSR é falha do teste. */
interface FakeClient extends HostClient {
  readonly calls: string[]
}

function fakeClient(state: 'open' | 'connecting' | 'closed' = 'open'): FakeClient {
  const calls: string[] = []
  return {
    calls,
    state,
    call: <T,>(method: string, params?: unknown): Promise<T> => {
      calls.push(`call ${method} ${JSON.stringify(params ?? null)}`)
      return Promise.reject(new Error(`não esperado no SSR: ${method}`))
    },
    stream: <T,>(method: string, params?: unknown): AsyncIterable<T> => {
      throw new Error(`stream não esperado no SSR: ${method} ${JSON.stringify(params ?? null)}`)
    },
    whenOpen: (timeoutMs?: number): Promise<void> => {
      calls.push(`whenOpen ${timeoutMs ?? ''}`)
      return Promise.resolve()
    },
  }
}

function renderShell(registry: SlotRegistry, client: HostClient): string {
  return renderToStaticMarkup(
    createElement(SlotProvider, { registry }, createElement(Shell, { client })),
  )
}

function renderConversation(registry: SlotRegistry, conversation: Conversation): string {
  return renderToStaticMarkup(
    createElement(SlotProvider, { registry }, createElement(ConversationView, { conversation })),
  )
}

/** Linha de tool, com narrowing — asserções de tool sem casts em cada teste. */
function toolOf(message: Message | undefined): Extract<Message, { kind: 'tool' }> {
  if (!message || message.kind !== 'tool') {
    throw new Error(`esperava uma linha de tool, veio ${message ? message.kind : 'nada'}`)
  }
  return message
}

// ---------------------------------------------------------------------------
// 1. Reducer da conversa
// ---------------------------------------------------------------------------

describe('reducer da conversa', () => {
  it('acumula os deltas numa só bolha', () => {
    let conversation = emptyConversation()
    conversation = appendUser(conversation, 'olá')
    conversation = applyEvent(conversation, { type: 'text_delta', text: 'Boa ' })
    conversation = applyEvent(conversation, { type: 'text_delta', text: 'dia' })

    expect(conversation.messages).toEqual([
      { kind: 'user', text: 'olá' },
      { kind: 'assistant', text: 'Boa dia' },
    ])
    expect(conversation.bubble).toBe(1)
    expect(conversation.tools).toEqual({})
  })

  it('ordena texto → tool → texto e fecha a bolha na tool', () => {
    let conversation = emptyConversation()
    conversation = appendUser(conversation, 'lê o ficheiro')
    conversation = applyEvent(conversation, { type: 'text_delta', text: 'vou ler' })
    conversation = applyEvent(conversation, {
      type: 'tool_use_start',
      id: 't1',
      name: 'fs.read',
      input: { path: 'a.txt' },
    })
    conversation = applyEvent(conversation, {
      type: 'tool_end',
      id: 't1',
      name: 'fs.read',
      ok: true,
      output: 'conteúdo',
      durationMs: 7,
    })
    conversation = applyEvent(conversation, { type: 'text_delta', text: 'está lido' })
    conversation = applyEvent(conversation, {
      type: 'turn_end',
      text: 'Li o ficheiro.',
      steps: 1,
      stoppedByLimit: false,
    })

    expect(conversation.messages.map((message) => message.kind)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ])
    expect(conversation.messages[1]).toEqual({ kind: 'assistant', text: 'vou ler' })
    expect(toolOf(conversation.messages[2])).toMatchObject({
      ok: true,
      output: 'conteúdo',
      durationMs: 7,
    })
    expect(conversation.messages[3]).toEqual({ kind: 'assistant', text: 'Li o ficheiro.' })
    expect(conversation.bubble).toBe(3)
    expect(conversation.tools).toEqual({ t1: 2 })
  })

  it('actualiza a linha certa com duas tools em paralelo', () => {
    let conversation = emptyConversation()
    conversation = applyEvent(conversation, {
      type: 'tool_use_start',
      id: 'a',
      name: 'fs.read',
      input: {},
    })
    conversation = applyEvent(conversation, {
      type: 'tool_use_start',
      id: 'b',
      name: 'fs.search',
      input: {},
    })
    conversation = applyEvent(conversation, {
      type: 'tool_end',
      id: 'b',
      name: 'fs.search',
      ok: false,
      output: 'sem matches',
      durationMs: 3,
    })

    expect(toolOf(conversation.messages[0]).id).toBe('a')
    // A primeira continua "a correr": o `tool_end` foi para a segunda.
    expect(toolOf(conversation.messages[0]).ok).toBeUndefined()
    expect(toolOf(conversation.messages[1])).toMatchObject({
      id: 'b',
      ok: false,
      output: 'sem matches',
      durationMs: 3,
    })
    expect(conversation.tools).toEqual({ a: 0, b: 1 })
  })

  it('um erro entra na conversa sem fechar a bolha em curso', () => {
    let conversation = emptyConversation()
    conversation = appendUser(conversation, 'tenta outra vez')
    conversation = applyEvent(conversation, { type: 'text_delta', text: 'parcial' })
    conversation = applyEvent(conversation, {
      type: 'error',
      code: 'provider',
      message: 'sem chave de API',
    })

    expect(conversation.messages.map((message) => message.kind)).toEqual([
      'user',
      'assistant',
      'error',
    ])
    expect(conversation.messages[1]).toEqual({ kind: 'assistant', text: 'parcial' })
    // A bolha continua aberta: o erro não é fim de turno.
    expect(conversation.bubble).toBe(1)

    // …e o texto seguinte continua a pertencer à MESMA resposta.
    conversation = applyEvent(conversation, { type: 'text_delta', text: ' — recuperado' })
    expect(conversation.messages).toHaveLength(3)
    expect(conversation.messages[1]).toEqual({
      kind: 'assistant',
      text: 'parcial — recuperado',
    })
  })

  it('turn_end substitui o texto dos deltas pelo texto canónico', () => {
    let conversation = emptyConversation()
    conversation = applyEvent(conversation, { type: 'text_delta', text: 'compa' })
    conversation = applyEvent(conversation, { type: 'text_delta', text: 'rto' })
    conversation = applyEvent(conversation, {
      type: 'turn_end',
      text: 'Comparo.',
      steps: 2,
      stoppedByLimit: false,
    })

    expect(conversation.messages).toEqual([{ kind: 'assistant', text: 'Comparo.' }])
    expect(conversation.bubble).toBe(0)
  })

  it('turn_start/step_* são contabilidade e não tocam na conversa', () => {
    let conversation = emptyConversation()
    conversation = applyEvent(conversation, { type: 'turn_start' })
    conversation = applyEvent(conversation, { type: 'step_start', step: 1 })
    conversation = applyEvent(conversation, {
      type: 'step_end',
      step: 1,
      stopReason: 'endTurn',
      inputTokens: 3,
      outputTokens: 4,
    })

    expect(conversation).toEqual(emptyConversation())
  })

  it('reconstrói a conversa do histórico persistido', () => {
    const conversation = fromHistory([
      { kind: 'user', text: 'olá', at: 1 },
      { kind: 'assistant', text: 'oi', at: 2 },
      { kind: 'tool', id: 't', name: 'fs.read', at: 3, ok: true, output: 'x' },
    ])

    expect(conversation.messages).toHaveLength(3)
    // Ao restaurar não há turno em curso — nada fica com bolha aberta.
    expect(conversation.bubble).toBeNull()
    expect(conversation.tools).toEqual({})
    expect(toolOf(conversation.messages[2])).toMatchObject({ ok: true, output: 'x' })
  })

  it('constrói o texto de estatísticas com plural e limite de passos', () => {
    expect(turnStats({ steps: 1, stoppedByLimit: false })).toBe('1 passo')
    expect(turnStats({ steps: 3, stoppedByLimit: false })).toBe('3 passos')
    expect(turnStats({ steps: 1, stoppedByLimit: true })).toBe('1 passo · limite de passos atingido')
    expect(turnStats({ steps: 8, stoppedByLimit: true })).toBe('8 passos · limite de passos atingido')
  })
})

// ---------------------------------------------------------------------------
// 2. SSR do shell
// ---------------------------------------------------------------------------

describe('SSR do shell', () => {
  it('renderiza a estrutura da UI sem tocar na rede', () => {
    const registry = new SlotRegistry()
    const client = fakeClient()
    const html = renderShell(registry, client)

    expect(html).toContain('<div class="app">')
    expect(html).toContain('<aside class="sidebar">')
    expect(html).toContain('Open Harness')
    expect(html).toContain('title="Nova sessão"')
    expect(html).toContain('<header class="topbar">')
    expect(html).toContain('sem sessão')
    expect(html).toContain('class="messages"')
    expect(html).toContain('<form class="composer">')
    expect(html).toContain('class="input"')
    expect(html).toContain('Enviar')

    // O rodapé reflecte o `state` real do cliente (paridade com a vanilla).
    expect(html).toContain('dot dot--on')
    expect(html).toContain('ligado')

    // Effects não correm em `renderToStaticMarkup`: se o arranque algum dia
    // fugir daqui para fora de um effect, este array deixa de estar vazio.
    expect(client.calls).toEqual([])
  })

  it('mostra o estado de ligação escolhido', () => {
    const html = renderShell(new SlotRegistry(), fakeClient('closed'))
    expect(html).toContain('dot dot--off')
    expect(html).toContain('desligado')
    expect(html).not.toContain('dot dot--on')
  })

  it('o shell não inscreve nada nos slots por conta própria', () => {
    const registry = new SlotRegistry()
    renderShell(registry, fakeClient())
    expect(registry.slots()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 3. Slots
// ---------------------------------------------------------------------------

describe('slots do shell', () => {
  it('declara a família aditiva e a de itens', () => {
    expect(Object.values(SLOTS)).toEqual([
      'sidebar.before',
      'sidebar.after',
      'topbar.before',
      'topbar.after',
      'messages.after',
      'composer.before',
      'composer.after',
    ])
    expect(DEFAULT_ITEM_ID).toBe('default')
    expect(itemSlot({ kind: 'user', text: '' })).toBe('chat.item.user')
    expect(itemSlot({ kind: 'assistant', text: '' })).toBe('chat.item.assistant')
    expect(itemSlot({ kind: 'error', text: '' })).toBe('chat.item.error')
    expect(itemSlot({ kind: 'tool', id: 't', name: 'n' })).toBe('chat.item.tool')
  })

  it('desenha a versão por omissão quando ninguém se inscreveu', () => {
    const registry = new SlotRegistry()
    const html = renderConversation(registry, fromHistory([
      { kind: 'user', text: 'olá', at: 1 },
      { kind: 'assistant', text: 'oi', at: 2 },
      { kind: 'tool', id: 't', name: 'fs.read', at: 3, ok: true, output: 'x' },
    ]))

    expect(html).toContain('msg msg--user')
    expect(html).toContain('msg msg--assistant')
    expect(html).toContain('ferramenta-name')
    expect(html).toContain('>fs.read<')
  })

  it('uma inscrição em `chat.item.user` substitui só as mensagens do utilizador', () => {
    const registry = new SlotRegistry()
    registry.register(
      'chat.item.user',
      (props: { message: Message }) =>
        createElement('b', { className: 'plugin-user' }, `plugin:${props.message.kind}`),
      { id: DEFAULT_ITEM_ID },
    )

    const html = renderConversation(
      registry,
      fromHistory([
        { kind: 'user', text: 'olá', at: 1 },
        { kind: 'assistant', text: 'oi', at: 2 },
        { kind: 'tool', id: 't', name: 'fs.read', at: 3, ok: true, output: 'x' },
      ]),
    )

    expect(html).toContain('plugin:user')
    expect(html).not.toContain('msg--user')
    // Os outros tipos continuam com o renderizador embutido.
    expect(html).toContain('msg msg--assistant')
    expect(html).toContain('ferramenta-name')
  })

  it('uma inscrição em `chat.item.tool` toma conta das linhas de tool', () => {
    const registry = new SlotRegistry()
    registry.register(
      'chat.item.tool',
      (props: { message: Message }) =>
        createElement('span', { className: 'tool-plugin' }, `tool:${toolOf(props.message).name}`),
      { id: DEFAULT_ITEM_ID },
    )

    const html = renderConversation(
      registry,
      fromHistory([{ kind: 'tool', id: 't', name: 'fs.read', at: 1, ok: true }]),
    )

    expect(html).toContain('tool:fs.read')
    expect(html).not.toContain('ferramenta-name')
    expect(html).not.toContain('<details')
  })

  it('um slot aditivo aparece ao lado do conteúdo do shell', () => {
    const registry = new SlotRegistry()
    registry.register(
      SLOTS.messagesAfter,
      () => createElement('p', { className: 'sugestoes' }, 'sugestões'),
      { id: 'sugestoes' },
    )

    const html = renderConversation(registry, fromHistory([
      { kind: 'user', text: 'olá', at: 1 },
    ]))

    expect(html).toContain('sugestões')
    // Aditivo: a conversa continua a desenhar-se por baixo.
    expect(html).toContain('msg msg--user')
  })

  it('inscrever o mesmo id duas vezes substitui em vez de duplicar', () => {
    const registry = new SlotRegistry()
    const first = registry.register('chat.item.user', () => 'primeiro', { id: DEFAULT_ITEM_ID })
    expect(registry.list('chat.item.user')).toHaveLength(1)
    registry.register('chat.item.user', () => 'segundo', { id: DEFAULT_ITEM_ID })
    expect(registry.list('chat.item.user')).toHaveLength(1)

    const html = renderConversation(
      registry,
      fromHistory([{ kind: 'user', text: 'olá', at: 1 }]),
    )
    expect(html).toContain('segundo')
    expect(html).not.toContain('primeiro')

    first()
    expect(registry.list('chat.item.user')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 4. Plugins de UI
// ---------------------------------------------------------------------------

describe('installPlugins', () => {
  it('instala só os módulos com `install` e devolve quantos instalaram', () => {
    const registry = new SlotRegistry()
    const installed: string[] = []
    const modules: unknown[] = [
      {
        install(target: SlotRegistry): void {
          target.register('chat.item.tool', () => 'a', { id: DEFAULT_ITEM_ID })
          installed.push('a')
        },
      },
      // Módulo só de CSS/efeitos — sem `install`, ignorado em vez de falhar.
      {},
      null,
      {
        install(): number {
          return installed.push('b')
        },
      },
    ]

    expect(installPlugins(modules, registry)).toBe(2)
    expect(installed).toEqual(['a', 'b'])
    expect(registry.list('chat.item.tool')).toHaveLength(1)
  })

  it('sem módulos não instala nada', () => {
    expect(installPlugins([], new SlotRegistry())).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 5. Plataforma servida pelo host
// ---------------------------------------------------------------------------

describe('plataforma do shell', () => {
  it('resolve os shims ESM e o vendor UMD no disco', () => {
    const files = platformFiles()
    expect([...files.keys()].sort()).toEqual([
      'react-dom-client.js',
      'react-dom.js',
      'react-jsx-runtime.js',
      'react-dom.umd.js',
      'react.umd.js',
      'react.js',
    ].sort())

    const missing = [...files]
      .filter(([, entry]) => !existsSync(join(entry.root, entry.file)))
      .map(([key, entry]) => `${key} -> ${join(entry.root, entry.file)}`)
    expect(missing).toEqual([])
  })

  it('cada entrada do mapa de plataforma aponta para um ficheiro servível', () => {
    const table = platformModules()
    expect(Object.keys(table).sort()).toEqual([
      'react',
      'react-dom',
      'react-dom/client',
      'react/jsx-runtime',
    ])

    const files = platformFiles()
    const unmapped = Object.entries(table)
      .filter(([, url]) => !files.has(url.slice('/platform/'.length)))
      .map(([specifier, url]) => `${specifier} -> ${url}`)
    expect(unmapped).toEqual([])
  })

  it('a entrada de browser não importa builtins de Node', () => {
    const dir = fileURLToPath(new URL('../src/', import.meta.url))
    const offenders = readdirSync(dir)
      .filter((name) => name !== 'platform.ts')
      .filter((name) => /from ['"]node:|import ['"]node:/.test(readFileSync(join(dir, name), 'utf8')))
    expect(offenders).toEqual([])
  })
})
