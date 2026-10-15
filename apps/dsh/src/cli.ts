import type { ProviderRegistry } from '@open-harness/dsh-provider'
import { HEADLESS_PROFILE, WEB_PROFILE, readVersion } from './profile.js'
import { loadAgentRegistry, runPrompt, type RunResult } from './run.js'
import { ScriptedAdapter, scriptedText, scriptedWrite } from './scripted.js'
import { runWeb, type WebOptions } from './web.js'

// ---------------------------------------------------------------------------
// Erros
// ---------------------------------------------------------------------------

/** Erro de utilização (argv inválido) → código de saída 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

/** Cancelamento pelo utilizador (SIGINT) → código de saída 130. */
export class CancelledError extends Error {
  constructor() {
    super('cancelled')
    this.name = 'CancelledError'
  }
}

// ---------------------------------------------------------------------------
// Argumentos
// ---------------------------------------------------------------------------

export interface CliArgs {
  prompt: string
  profile: string
  model?: string
  system?: string
  cwd?: string
  home?: string
  provider?: string
  offline: boolean
  verbose: boolean
  printSession: boolean
  /** `dsh models` / `--models`: lista provedores e modelos e sai. */
  models: boolean
  /** `dsh web` / `--web`: sobe o host web local em vez de correr um turno. */
  web: boolean
  /** Porta do servidor web (`dsh web`). */
  port?: string
  /** Endereço de escuta do servidor web (`dsh web`). */
  host?: string
  help: boolean
  version: boolean
}

const DEFAULT_ARGS: CliArgs = {
  prompt: '',
  // Vazio de propósito: o perfil por omissão depende do comando — `headless`
  // para um turno, `web` para `dsh web`. Quem chama resolve com `||`.
  profile: '',
  offline: false,
  verbose: false,
  printSession: false,
  models: false,
  web: false,
  help: false,
  version: false,
}

/** Opções que exigem valor. */
const VALUE_FLAGS: Record<string, keyof CliArgs> = {
  '--profile': 'profile',
  '-p': 'profile',
  '--model': 'model',
  '-m': 'model',
  '--system': 'system',
  '-s': 'system',
  '--cwd': 'cwd',
  '-C': 'cwd',
  '--home': 'home',
  '--provider': 'provider',
  '--port': 'port',
  '--host': 'host',
}

/**
 * Analisa argv (sem `node` nem script). Posicionais são unidos com espaço e
 * formam o prompt. `--` termina o parsing de opções.
 */
export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { ...DEFAULT_ARGS }
  const positional: string[] = []
  let optionsEnded = false

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!

    if (optionsEnded) {
      positional.push(token)
      continue
    }
    if (token === '--') {
      optionsEnded = true
      continue
    }

    const eq = token.indexOf('=')
    const flag = eq > 0 ? token.slice(0, eq) : token
    const inline = eq > 0 ? token.slice(eq + 1) : undefined

    if (flag in VALUE_FLAGS) {
      const key = VALUE_FLAGS[flag]!
      const value = inline ?? argv[++i]
      if (value === undefined) throw new UsageError(`${flag} requires a value`)
      ;(args as unknown as Record<string, unknown>)[key] = value
      continue
    }

    switch (token) {
      case '-h':
      case '--help':
        args.help = true
        continue
      case '--version':
        args.version = true
        continue
      case '--offline':
        args.offline = true
        continue
      case '-v':
      case '--verbose':
        args.verbose = true
        continue
      case '--print-session':
        args.printSession = true
        continue
      case '--models':
        args.models = true
        continue
      default:
        break
    }

    if (token.startsWith('-') && token !== '-') throw new UsageError(`unknown option: ${token}`)
    // Subcomandos: `dsh models` equivale a `dsh --models`, e o mesmo para `web`.
    // (Depois de `--` o token fica prompt — `dsh -- models ...` escreve mesmo
    // "models" ao modelo.)
    if (token === 'models' && positional.length === 0 && !args.models) {
      args.models = true
      continue
    }
    if (token === 'web' && positional.length === 0 && !args.web) {
      args.web = true
      continue
    }
    positional.push(token)
  }

  args.prompt = positional.join(' ').trim()
  return args
}

// ---------------------------------------------------------------------------
// Ajuda / versão
// ---------------------------------------------------------------------------

export const HELP = `dsh — Open Harness (recriação)

Uso:
  dsh [opções] <prompt>
  dsh models [opções]
  dsh web [opções]

Comandos:
  (nenhum)          Corre um turno com o prompt indicado
  models            Lista os provedores ligados e os modelos disponíveis
  web               Sobe o host web local (http://127.0.0.1:3080)

Opções:
  -p, --profile <nome>   Perfil a arrancar (default: ${HEADLESS_PROFILE}, ou ${WEB_PROFILE} em \`web\`)
  -m, --model <ref>      Modelo a usar: <provedor>/<modelo> (ex.: openai/gpt-5.4)
                         (default: o do perfil)
      --provider <id>    Com \`models\`: mostra só esse provedor
  -s, --system <texto>   Substitui o system prompt
  -C, --cwd <dir>        Directorio de trabalho do agente (default: o cwd)
      --home <dir>       Home de dados (default: ~/.open-harness)
      --port <n>         Com \`web\`: porta do servidor (default: 3080; 0 = livre)
      --host <addr>      Com \`web\`: endereço de escuta (default: 127.0.0.1)
      --offline          Corre sem rede com um modelo de demonstração
                         (escreve README.md para exercitar tools + persistência)
  -v, --verbose          Diagnóstico em stderr (passos, tools, sessão)
      --print-session    Imprime só o caminho da sessão no fim
  -h, --help             Esta ajuda
      --version          Versão da CLI

Provedores:
  Os provedores são declarados no perfil, no bloco \`agent.config.providers\`
  (chave, endpoint, protocolo e catálogo de modelos). O catálogo embutido já
  conhece deepseek, anthropic, openai, google, openrouter, groq e ollama; as
  chaves vêm do ambiente (DEEPSEEK_API_KEY, OPENAI_API_KEY, …).

Exemplos:
  dsh --profile headless "crie um README"
  dsh --offline -v "crie um README"
  dsh --model openai/gpt-5.4 "explique este repositório"
  dsh models
  dsh models --provider openrouter
  dsh web --port 3080
  dsh web --offline --port 0

Sessão: <home>/sessions/<workspace>/<id>/session.v4.jsonl.zstd
Home:   OPEN_HARNESS_HOME (ou OHSH_HOME), por omissão ~/.open-harness
`

// ---------------------------------------------------------------------------
// Modo offline
// ---------------------------------------------------------------------------

/**
 * Adapter de demonstração para `--offline`: **não há rede**. O primeiro passo
 * pede a escrita de `README.md` (tool real, com o fs verdadeiro) e o segundo
 * encerra o turno — exercita o pipeline completo (boot → tools → persistência
 * → saída) de forma determinística.
 */
export function offlineAdapter(cwd: string, prompt: string): ScriptedAdapter {
  const body = [
    '# README',
    '',
    `Gerado pelo modo \`--offline\` da CLI \`dsh\` em \`${cwd}\`.`,
    '',
    `Pedido: ${prompt || '(sem prompt)'}`,
    '',
  ].join('\n')

  return new ScriptedAdapter([
    scriptedWrite('README.md', body),
    scriptedText(`README.md escrito em ${cwd} (modo --offline: sem chamadas de rede).`),
  ])
}

/**
 * Adapter offline para `dsh web`.
 *
 * A CLI de turno tem uma fila finita de respostas; o servidor web tem turnos
 * ilimitados, por isso o adapter vem com uma resposta fixa de reserva — o
 * turno devolve sempre algo legível em vez de terminar vazio.
 */
export function offlineWebAdapter(cwd: string): ScriptedAdapter {
  return new ScriptedAdapter(
    [],
    scriptedText(`Resposta offline em ${cwd} (modo --offline: sem chamadas de rede).`),
  )
}

/** Analisa `--port`; `undefined` quando ausente, `null` quando inválido. */
function parsePort(raw: string | undefined): number | null | undefined {
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0 || value > 65535) return null
  return value
}

// ---------------------------------------------------------------------------
// Execução
// ---------------------------------------------------------------------------

/** Código de saída por classe de erro. */
export function exitCodeFor(error: unknown): number {
  if (error instanceof UsageError) return 2
  if (error instanceof CancelledError) return 130
  return 1
}

export interface RunCliOptions {
  /** Echo de diagnóstico (default `console.error`). */
  log?: (line: string) => void
  /** Echo da saída principal (default `console.log`). */
  out?: (line: string) => void
  /** Cancelamento externo (SIGINT na camada `main`). */
  signal?: AbortSignal
}

function padCell(value: string, width: number): string {
  return value.length >= width ? `${value} ` : value.padEnd(width)
}

/** Estado da chave de um provedor, para a listagem. */
function keyState(provider: { hasApiKey: boolean; requiresApiKey: boolean }): string {
  if (!provider.requiresApiKey) return 'local'
  return provider.hasApiKey ? 'ok' : 'falta'
}

/**
 * Formata a listagem de provedores e modelos (`dsh models`) — o equivalente à
 * ferramenta `models` do OpenCode, para descobrir o que está ligado antes de
 * escolher uma referência `provedor/modelo`.
 */
export function formatModelListing(
  registry: ProviderRegistry,
  filter: { profile?: string; provider?: string } = {},
): string[] {
  const providers = registry
    .listProviders()
    .filter((provider) => !filter.provider || provider.id === filter.provider)
  const models = registry.listModels(filter.provider ? { provider: filter.provider } : {})

  const lines: string[] = []
  if (filter.profile) lines.push(`perfil    ${filter.profile}`)
  lines.push('')
  lines.push('PROVEDORES  (* = catálogo embutido)')
  lines.push(
    padCell('ID', 16) + padCell('PROTOCOLO', 20) + padCell('CHAVE', 8) + padCell('MODELOS', 9) + 'ENDPOINT',
  )
  for (const provider of providers) {
    lines.push(
      padCell(`${provider.id}${provider.builtin ? ' *' : ''}`, 16) +
        padCell(provider.api, 20) +
        padCell(keyState(provider), 8) +
        padCell(String(provider.modelCount), 9) +
        provider.baseURL,
    )
  }

  lines.push('')
  lines.push('MODELOS  (usar como --model <ref>)')
  lines.push(
    padCell('REF', 40) + padCell('CONTEXTO', 12) + padCell('SAÍDA', 10) + padCell('TOOLS', 7) + 'CUSTO in/out (USD/M)',
  )
  for (const model of models) {
    const cost =
      model.cost?.input !== undefined && model.cost?.output !== undefined
        ? `${model.cost.input} / ${model.cost.output}`
        : '-'
    lines.push(
      padCell(model.ref, 40) +
        padCell(String(model.contextWindow), 12) +
        padCell(model.maxTokens !== undefined ? String(model.maxTokens) : '-', 10) +
        padCell(model.toolCall ? 'sim' : 'não', 7) +
        cost,
    )
  }
  return lines
}

/**
 * Corre a CLI e devolve o código de saída. Não chama `process.exit` — a camada
 * `main.ts` é que o faz, para que os testes possam chamar isto em processo.
 */
export async function runCli(argv: readonly string[], options: RunCliOptions = {}): Promise<number> {
  const log = options.log ?? ((line: string) => console.error(line))
  const out = options.out ?? ((line: string) => console.log(line))

  let args: CliArgs
  try {
    args = parseArgs(argv)
  } catch (error) {
    log(`dsh: ${error instanceof Error ? error.message : String(error)}`)
    log('corra `dsh --help` para ver as opções')
    return 2
  }

  if (args.help) {
    out(HELP)
    return 0
  }
  if (args.version) {
    out(readVersion())
    return 0
  }
  // `models` não precisa de prompt — tem de ser verificado antes dessa falta.
  if (args.models) {
    const { registry, profile } = loadAgentRegistry({
      profile: args.profile || HEADLESS_PROFILE,
      ...(args.home !== undefined ? { homeDir: args.home } : {}),
    })
    if (args.provider && !registry.get(args.provider)) {
      log(`dsh: provedor desconhecido "${args.provider}" (conhecidos: ${registry.ids().join(', ')})`)
      return 2
    }
    const listing = formatModelListing(registry, {
      profile,
      ...(args.provider !== undefined ? { provider: args.provider } : {}),
    })
    for (const line of listing) out(line)
    return 0
  }
  // `web` não precisa de prompt — arranca o host e fica à espera de Ctrl+C.
  if (args.web) {
    const port = parsePort(args.port)
    if (port === null) {
      log('dsh: --port tem de ser um número entre 0 e 65535')
      return 2
    }
    try {
      const webOptions: WebOptions = {
        profile: args.profile || WEB_PROFILE,
        ...(port !== undefined ? { port } : {}),
        ...(args.host !== undefined ? { host: args.host } : {}),
        ...(args.model !== undefined ? { model: args.model } : {}),
        ...(args.system !== undefined ? { system: args.system } : {}),
        ...(args.home !== undefined ? { homeDir: args.home } : {}),
        ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
        ...(args.offline ? { adapter: offlineWebAdapter(args.cwd ?? process.cwd()) } : {}),
        // O anúncio de arranque (URL e token) passa sempre pelo `log` — sem
        // ele ninguém adivinha onde o servidor ficou a escutar.
        log,
        ...(options.signal ? { signal: options.signal } : {}),
      }
      await runWeb(webOptions)
      return 0
    } catch (error) {
      log(`dsh: ${error instanceof Error ? error.message : String(error)}`)
      if (args.verbose && error instanceof Error && error.stack) log(error.stack)
      return 1
    }
  }
  if (!args.prompt) {
    log('dsh: falta o prompt')
    log('corra `dsh --help` para ver as opções')
    return 2
  }

  const cwd = args.cwd ?? process.cwd()
  const started = Date.now()

  try {
    const result: RunResult = await runPrompt({
      prompt: args.prompt,
      profile: args.profile || HEADLESS_PROFILE,
      ...(args.model !== undefined ? { model: args.model } : {}),
      ...(args.system !== undefined ? { system: args.system } : {}),
      ...(args.home !== undefined ? { homeDir: args.home } : {}),
      ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
      ...(args.offline ? { adapter: offlineAdapter(cwd, args.prompt) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    })

    if (args.printSession) {
      out(result.sessionPath)
      return 0
    }

    if (result.outcome.text) out(result.outcome.text)
    else if (result.outcome.stoppedByLimit) log('dsh: o turno atingiu o limite de steps sem resposta final')

    if (args.verbose) {
      const { outcome } = result
      log(`perfil     ${result.profile} (${result.profileDir})`)
      log(`passos     ${outcome.steps}${outcome.stoppedByLimit ? ' (limite atingido)' : ''}`)
      for (const exec of outcome.toolExecutions) {
        log(`tool       ${exec.name}${exec.isError ? ' [erro]' : ''} ${exec.durationMs}ms`)
      }
      for (const trace of outcome.traces) {
        log(
          `request    step=${trace.step} msgs=${trace.messageCount} tools=${trace.toolSpecs.length} ` +
            `in=${trace.inputTokens} out=${trace.outputTokens} stop=${trace.stopReason}`,
        )
      }
      log(`sessão     ${result.sessionPath}`)
      log(`duracao    ${Date.now() - started}ms`)
    }

    return 0
  } catch (error) {
    if (options.signal?.aborted) {
      log('dsh: cancelado')
      return 130
    }
    log(`dsh: ${error instanceof Error ? error.message : String(error)}`)
    if (args.verbose && error instanceof Error && error.stack) log(error.stack)
    return 1
  }
}
