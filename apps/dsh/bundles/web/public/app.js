// ---------------------------------------------------------------------------
// Interface do Open Harness (Fase 3 — superfície web)
//
// Uma página só, sem framework e sem bundler: o import map do index.html
// resolve os módulos compilados do próprio repositório (`dsh-client-connection`
// fala com o host pelo protocolo Typert Remote — um WebSocket multiplexado).
//
// Fluxo: ligar → listar sessões → abrir uma (com o histórico persistido) →
// compor → correr o turno vendo os eventos em stream → cancelar/renovar.
// ---------------------------------------------------------------------------
import { createClient } from '@open-harness/dsh-client-connection'

const token = window.__DSH_TOKEN__

/** Atalho a `getElementById` — a página toda é estática. */
const $ = (id) => document.getElementById(id)

const dom = {
  app: $('app'),
  sessions: $('sessions'),
  newChat: $('new-chat'),
  conn: $('conn'),
  hostInfo: $('host-info'),
  title: $('title'),
  context: $('context'),
  stats: $('stats'),
  messages: $('messages'),
  composer: $('composer'),
  input: $('input'),
  send: $('send'),
  cancel: $('cancel'),
  status: $('status'),
}

const client = createClient({ url: location.origin, token })

/** Sessões que o host devolveu (a activa é a que está em `current`). */
let sessions = []
let current = null
/** Turno em curso — `running` bloqueia envio, `jobId` permite cancelar. */
let running = false
let jobId = null

// ---------------------------------------------------------------------------
// Elementos
// ---------------------------------------------------------------------------

/** Cria um elemento já com classe e (opcionalmente) texto. */
function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** Bolha da conversa: papel + texto. */
function messageBox(role, className, text) {
  const box = el('div', `msg msg--${className}`)
  box.append(el('div', 'msg-role', role), el('div', 'msg-text', text ?? ''))
  return box
}

/** Linha de tool — `ok?` indefinido significa "ainda a correr". */
function toolBox(entry) {
  const box = el(
    'details',
    `ferramenta${entry.ok === undefined ? ' ferramenta--running' : entry.ok ? ' ferramenta--ok' : ' ferramenta--fail'}`,
  )
  const summary = el('summary', 'ferramenta-head')
  summary.append(
    el('span', 'ferramenta-name', entry.name),
    el('span', 'ferramenta-state', entry.ok === undefined ? 'a correr…' : entry.ok ? 'ok' : 'erro'),
  )
  box.append(summary)
  if (entry.output) box.append(el('pre', 'ferramenta-output', entry.output))
  return box
}

/** Actualiza uma linha de tool quando chega o `tool_end`. */
function finishTool(box, event) {
  box.classList.remove('ferramenta--running')
  box.classList.add(event.ok ? 'ferramenta--ok' : 'ferramenta--fail')
  box.querySelector('.ferramenta-state').textContent =
    `${event.ok ? 'ok' : 'erro'} · ${event.durationMs} ms`
  if (event.output) {
    let pre = box.querySelector('.ferramenta-output')
    if (!pre) {
      pre = el('pre', 'ferramenta-output')
      box.append(pre)
    }
    pre.textContent = event.output
  }
}

// ---------------------------------------------------------------------------
// Estado da barra e da ligação
// ---------------------------------------------------------------------------

function setStatus(text, isError = false) {
  dom.status.textContent = text
  dom.status.classList.toggle('status--error', isError)
}

function syncControls() {
  dom.input.disabled = running
  dom.send.disabled = running
  dom.cancel.hidden = !running
  if (!running && dom.status.classList.contains('status--error')) setStatus('')
}

/** O mux reconecta sozinho; aqui só se reflecte o estado no ponto da barra. */
function pollConnection() {
  const state = client.state
  dom.conn.textContent = state === 'open' ? 'ligado' : state === 'connecting' ? 'a ligar…' : 'desligado'
  dom.conn.className = `dot dot--${state === 'open' ? 'on' : state === 'connecting' ? 'wait' : 'off'}`
}

function scrollToEnd() {
  dom.messages.scrollTop = dom.messages.scrollHeight
}

// ---------------------------------------------------------------------------
// Sessões
// ---------------------------------------------------------------------------

async function refreshSessions() {
  const reply = await client.call('session.list')
  sessions = reply.sessions ?? []
  renderSessions()
  return sessions
}

function renderSessions() {
  dom.sessions.replaceChildren()
  for (const session of sessions) {
    const item = el('li', `session${current && current.id === session.id ? ' session--active' : ''}`)
    item.tabIndex = 0
    const remove = el('button', 'session-remove', '×')
    remove.type = 'button'
    remove.title = 'Remover sessão'
    remove.addEventListener('click', async (event) => {
      event.stopPropagation()
      if (running) return
      try {
        await client.call('session.remove', { sessionId: session.id })
        if (current && current.id === session.id) {
          current = null
          dom.messages.replaceChildren()
        }
        const left = await refreshSessions()
        if (left.length === 0) await newSession()
        else if (!current) await openSession(left[0])
      } catch (failure) {
        setStatus(failure.message || String(failure), true)
      }
    })
    item.append(el('span', 'session-name', session.title), remove)
    item.addEventListener('click', () => {
      void openSession(session)
    })
    item.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') void openSession(session)
    })
    dom.sessions.append(item)
  }
}

/** Abre uma sessão: cabeçalho + histórico persistido no disco. */
async function openSession(session) {
  if (running) return
  current = session
  renderSessions()
  dom.title.textContent = session.title
  dom.context.textContent = [session.cwd, session.modelRef].filter(Boolean).join(' · ')
  dom.stats.textContent = ''
  try {
    const reply = await client.call('session.history', { sessionId: session.id })
    renderHistory(reply.entries ?? [])
  } catch (failure) {
    setStatus(failure.message || String(failure), true)
  }
}

async function newSession() {
  if (running) return
  try {
    const created = await client.call('session.create', {})
    await refreshSessions()
    await openSession(created)
  } catch (failure) {
    setStatus(failure.message || String(failure), true)
  }
}

// ---------------------------------------------------------------------------
// Conversa
// ---------------------------------------------------------------------------

function renderHistory(entries) {
  dom.messages.replaceChildren()
  for (const entry of entries) {
    if (entry.kind === 'user') dom.messages.append(messageBox('tu', 'user', entry.text))
    else if (entry.kind === 'assistant') dom.messages.append(messageBox('agente', 'assistant', entry.text))
    else dom.messages.append(toolBox(entry))
  }
  scrollToEnd()
}

/** Erro visível na conversa (falha de transporte ou do turno). */
function appendError(text) {
  dom.messages.append(messageBox('erro', 'error', text))
  scrollToEnd()
}

/**
 * Corre um turno e desenha-o à medida que os eventos chegam.
 *
 * O texto chega em deltas; as tools, como linhas próprias. Cada tool fecha o
 * balão de texto em curso — se depois houver mais texto, abre-se outro, para
 * a ordem da conversa ser a mesma que o agente viveu.
 */
async function runTurn(text) {
  running = true
  jobId = null
  syncControls()

  dom.messages.append(messageBox('tu', 'user', text))
  let bubble = null
  const toolRows = new Map()

  try {
    for await (const event of client.stream('job.run', { sessionId: current.id, text })) {
      if (event.type === 'job_start') {
        jobId = event.jobId
        syncControls()
      } else if (event.type === 'text_delta') {
        if (!bubble) {
          bubble = messageBox('agente', 'assistant', '')
          dom.messages.append(bubble)
        }
        bubble.querySelector('.msg-text').textContent += event.text
        scrollToEnd()
      } else if (event.type === 'tool_use_start') {
        bubble = null
        const row = toolBox({ kind: 'tool', id: event.id, name: event.name, at: Date.now() })
        row.open = true
        toolRows.set(event.id, row)
        dom.messages.append(row)
        scrollToEnd()
      } else if (event.type === 'tool_end') {
        const row = toolRows.get(event.id)
        if (row) finishTool(row, event)
        scrollToEnd()
      } else if (event.type === 'turn_end') {
        // O texto final é o canónico — substitui o que veio por deltas.
        if (!bubble) {
          bubble = messageBox('agente', 'assistant', '')
          dom.messages.append(bubble)
        }
        bubble.querySelector('.msg-text').textContent = event.text
        dom.stats.textContent =
          `${event.steps} ${event.steps === 1 ? 'passo' : 'passos'}` +
          (event.stoppedByLimit ? ' · limite de passos atingido' : '')
      } else if (event.type === 'error') {
        appendError(`${event.code}: ${event.message}`)
      }
      // `step_start`/`step_end` não desenham nada: são contabilidade do loop,
      // e no ecrã só serviriam de ruído.
    }
  } catch (failure) {
    appendError(failure.message || String(failure))
  } finally {
    running = false
    jobId = null
    syncControls()
    scrollToEnd()
    void refreshSessions()
  }
}

// ---------------------------------------------------------------------------
// Ligações da UI
// ---------------------------------------------------------------------------

dom.composer.addEventListener('submit', (event) => {
  event.preventDefault()
  const text = dom.input.value.trim()
  if (!text || running || !current) return
  dom.input.value = ''
  dom.input.style.height = 'auto'
  void runTurn(text)
})

dom.input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    dom.composer.requestSubmit()
  }
})

// Cresce com o texto, com teto para não comer a conversa.
dom.input.addEventListener('input', () => {
  dom.input.style.height = 'auto'
  dom.input.style.height = `${Math.min(dom.input.scrollHeight, 200)}px`
})

dom.cancel.addEventListener('click', async () => {
  if (!jobId) return
  try {
    await client.call('job.cancel', { jobId })
    setStatus('a cancelar…')
  } catch (failure) {
    setStatus(failure.message || String(failure), true)
  }
})

dom.newChat.addEventListener('click', () => {
  void newSession()
})

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------

async function boot() {
  if (!token) return // o index.html já mostrou o aviso

  dom.app.hidden = false
  dom.input.focus()
  dom.conn.textContent = 'a ligar…'
  dom.conn.className = 'dot dot--wait'
  setInterval(pollConnection, 500)

  try {
    await client.whenOpen(10_000)
  } catch (failure) {
    setStatus(failure.message || String(failure), true)
    return
  }

  try {
    const info = await client.call('workspace.info')
    dom.hostInfo.textContent = `${info.version} · ${info.platform}`
  } catch {
    // o rodapé é cosmético — não vale a pena falhar o arranque por ele
  }

  try {
    const list = await refreshSessions()
    if (list.length === 0) await newSession()
    else await openSession(list[0])
  } catch (failure) {
    setStatus(failure.message || String(failure), true)
  }

  dom.input.focus()
}

void boot()
