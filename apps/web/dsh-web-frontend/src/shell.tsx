// ---------------------------------------------------------------------------
// O shell: sessões + conversa + composer.
//
// Esta é a única parte da UI que conhece o protocolo do host. Os blocos são
// desenhados aqui (sidebar, topbar, conversa, composer) e ficam todos atrás de
// slots, para que os pacotes `ui-*` possam substituir ou acrescentar sem o
// shell os conhecer — ver `slots.ts` para a semântica de cada família.
//
// O componente recebe o cliente em `props` (em vez de o criar): assim os
// testes montam o shell com um cliente falso, e o bootstrap é que escolhe o
// URL real.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { ConnectionState, HistoryEntry, SessionInfo, WorkspaceInfo } from './types.js'
import {
  appendUser,
  applyEvent,
  emptyConversation,
  fromHistory,
  turnStats,
  type Conversation,
} from './conversation.js'
import { ConversationView } from './conversation-view.js'
import { Sidebar } from './sidebar.js'
import { Topbar } from './topbar.js'
import { Composer } from './composer.js'

/**
 * Suficiência do cliente do host, do ponto de vista da UI.
 *
 * É um subconjunto estrutural de `RemoteClient` (`dsh-client-connection`), o
 * que deixa o shell desacoplado do transporte: testes e futuros adaptadores
 * satisfazem a mesma interface sem reimplementar nada.
 */
export interface HostClient {
  readonly state: ConnectionState
  call<T = unknown>(method: string, params?: unknown): Promise<T>
  stream<T = unknown>(method: string, params?: unknown): AsyncIterable<T>
  whenOpen(timeoutMs?: number): Promise<void>
}

export interface ShellProps {
  client: HostClient
}

interface Status {
  text: string
  isError: boolean
}

export function Shell(props: ShellProps): ReactNode {
  const { client } = props

  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [current, setCurrent] = useState<SessionInfo | null>(null)
  const [conversation, setConversation] = useState<Conversation>(emptyConversation)
  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState<Status>({ text: '', isError: false })
  const [stats, setStats] = useState('')
  const [connection, setConnection] = useState<ConnectionState>(client.state)
  const [hostInfo, setHostInfo] = useState('')

  const jobId = useRef<string | null>(null)

  // O id da sessão a que o turno pertence: guarda-se porque o utilizador pode
  // trocar de sessão a meio de um turno, e os deltas do turno antigo não
  // podem entrar na conversa nova.
  const turnSession = useRef<string | null>(null)

  // Valor corrente de `running` para os guards de negócio. É um ref (e não o
  // estado) de propósito: um estado aqui mudava a identidade de `openSession`
  // e `removeSession` a cada turno, e essas identidades são dependências do
  // efeito de arranque — ver o comentário em cima dele. O estado continua a
  // existir, só que é propriedade de render (botões do composer).
  const runningRef = useRef(false)

  function notice(text: string, isError = false): void {
    setStatus({ text, isError })
  }

  /** Actualiza a lista de sessões e devolve-a (o arranque decide o que abrir). */
  const refreshSessions = useCallback(async (): Promise<SessionInfo[]> => {
    const reply = await client.call<{ sessions: SessionInfo[] }>('session.list')
    setSessions(reply.sessions ?? [])
    return reply.sessions ?? []
  }, [client])

  /** Abre uma sessão: cabeçalho + histórico persistido no disco. */
  const openSession = useCallback(
    async (session: SessionInfo): Promise<void> => {
      if (runningRef.current) return
      const reply = await client.call<{ entries: HistoryEntry[] }>('session.history', {
        sessionId: session.id,
      })
      setCurrent(session)
      setConversation(fromHistory(reply.entries ?? []))
      setStats('')
      notice('')
    },
    [client],
  )

  const newSession = useCallback(async (): Promise<void> => {
    if (runningRef.current) return
    // `session.create` devolve a própria sessão — não um invólucro.
    const created = await client.call<SessionInfo>('session.create', {})
    await refreshSessions()
    await openSession(created)
  }, [client, refreshSessions, openSession])

  const removeSession = useCallback(
    async (session: SessionInfo): Promise<void> => {
      if (runningRef.current) return
      await client.call('session.remove', { sessionId: session.id })
      // A sessão aberta era a removida: limpa a conversa antes de escolher a
      // seguinte, para não deixar um ecrã com o histórico de um id morto.
      const wasCurrent = current?.id === session.id
      if (wasCurrent) {
        setCurrent(null)
        setConversation(emptyConversation())
        setStats('')
      }
      const left = await refreshSessions()
      if (left.length === 0) await newSession()
      else if (wasCurrent) await openSession(left[0])
    },
    [client, current, refreshSessions, newSession, openSession],
  )

  const cancelTurn = useCallback((): void => {
    const id = jobId.current
    if (!id) return
    void (async () => {
      try {
        await client.call('job.cancel', { jobId: id })
        notice('a cancelar…')
      } catch (failure) {
        notice(failure instanceof Error ? failure.message : String(failure), true)
      }
    })()
  }, [client])

  /** Corre um turno, consumindo os eventos do fio até ao fim. */
  const runTurn = useCallback(
    async (session: SessionInfo, text: string): Promise<void> => {
      turnSession.current = session.id
      runningRef.current = true
      setRunning(true)
      setConversation((previous) => appendUser(previous, text))
      try {
        const stream = client.stream<{ type?: string; jobId?: string }>('job.run', {
          sessionId: session.id,
          text,
        })
        for await (const event of stream) {
          // Deltas para a sessão certa: se o utilizador trocar de sessão a
          // meio do turno, estes eventos já não tocam à conversa nova.
          if (turnSession.current !== session.id) continue

          if (event.type === 'job_start' && typeof event.jobId === 'string') {
            jobId.current = event.jobId
            continue
          }
          if (event.type === 'turn_end') {
            const ended = event as unknown as { steps: number; stoppedByLimit: boolean }
            setStats(turnStats(ended))
            continue
          }
          // Erros de turno entram na conversa (não na barra): são texto que o
          // utilizador tem de poder reler depois de o turno acabar.
          setConversation((previous) => applyEvent(previous, event as never))
        }
      } catch (failure) {
        setConversation((previous) =>
          applyEvent(previous, {
            type: 'error',
            code: 'transport',
            message: failure instanceof Error ? failure.message : String(failure),
          }),
        )
      } finally {
        jobId.current = null
        turnSession.current = null
        runningRef.current = false
        setRunning(false)
        // Como a UI vanilla: um erro de barra (cancelar, abrir sessão) não
        // sobrevive ao fim do turno — o próximo turno parte de estado limpo.
        setStatus((previous) => (previous.isError ? { text: '', isError: false } : previous))
        try {
          await refreshSessions()
        } catch {
          // Repor a lista é cosmético — não vale a pena falhar o turno por isso.
        }
      }
    },
    [client, refreshSessions],
  )

  const submit = useCallback(
    (text: string): void => {
      if (!current) return
      void runTurn(current, text)
    },
    [current, runTurn],
  )

  // ---------------------------------------------------------------------------
  // Ligação e arranque
  // ---------------------------------------------------------------------------

  // O estado da ligação é observado, não inferido: o `state` do cliente muda
  // silenciosamente durante reconexões, e o `whenOpen` do arranque só cobre a
  // primeira.
  useEffect(() => {
    const timer = setInterval(() => setConnection(client.state), 500)
    return () => clearInterval(timer)
  }, [client])

  // O arranque corre UMA vez por ligação: por isso as dependências abaixo
  // têm de ser estáveis. O `openSession` protege-se por um ref (e não pelo
  // estado `running`) precisamente para isso — o estado no array de deps
  // recriava os callbacks a cada turno, o efeito corria de novo e reabria a
  // sessão, apagando as estatísticas e reescrevendo a conversa pelo histórico
  // que o turno acabou de gravar.
  useEffect(() => {
    void (async () => {
      try {
        await client.whenOpen(10_000)
      } catch (failure) {
        notice(failure instanceof Error ? failure.message : String(failure), true)
        return
      }
      try {
        const info = await client.call<WorkspaceInfo>('workspace.info')
        setHostInfo(`${info.version} · ${info.platform}`)
      } catch {
        // O rodapé é cosmético — não vale a pena falhar o arranque por ele.
      }
      try {
        const list = await refreshSessions()
        if (list.length === 0) await newSession()
        else await openSession(list[0])
      } catch (failure) {
        notice(failure instanceof Error ? failure.message : String(failure), true)
      }
    })()
  }, [client, refreshSessions, newSession, openSession])

  return (
    <div className="app">
      <Sidebar
        sessions={sessions}
        currentId={current?.id ?? null}
        connection={connection}
        hostInfo={hostInfo}
        onNew={() => void newSession()}
        onOpen={(session) => void openSession(session)}
        onRemove={(session) => void removeSession(session)}
      />
      <main className="main">
        <Topbar
          title={current?.title ?? ''}
          context={current ? [current.cwd, current.modelRef].filter(Boolean).join(' · ') : ''}
          stats={stats}
        />
        <ConversationView conversation={conversation} />
        <Composer
          running={running}
          status={status.text}
          statusIsError={status.isError}
          onSubmit={submit}
          onCancel={cancelTurn}
        />
      </main>
    </div>
  )
}
