import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HEADLESS_PROFILE, cliPackageRoot } from './profile.js'
import { runPrompt, type RunResult } from './run.js'
import { ScriptedAdapter, scriptedText, scriptedWrite } from './scripted.js'

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
  offline: boolean
  verbose: boolean
  printSession: boolean
  help: boolean
  version: boolean
}

const DEFAULT_ARGS: CliArgs = {
  prompt: '',
  profile: HEADLESS_PROFILE,
  offline: false,
  verbose: false,
  printSession: false,
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
      default:
        break
    }

    if (token.startsWith('-') && token !== '-') throw new UsageError(`unknown option: ${token}`)
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

Opções:
  -p, --profile <nome>   Perfil a arrancar (default: ${HEADLESS_PROFILE})
  -m, --model <id>       Modelo a usar (default: o do perfil)
  -s, --system <texto>   Substitui o system prompt
  -C, --cwd <dir>        Directorio de trabalho do agente (default: o cwd)
      --home <dir>       Home de dados (default: ~/.open-harness)
      --offline          Corre sem rede com um modelo de demonstração
                         (escreve README.md para exercitar tools + persistência)
  -v, --verbose          Diagnóstico em stderr (passos, tools, sessão)
      --print-session    Imprime só o caminho da sessão no fim
  -h, --help             Esta ajuda
      --version          Versão da CLI

Exemplos:
  dsh --profile headless "crie um README"
  dsh --offline -v "crie um README"
  dsh --profile headless --model deepseek-v4-pro "explique este repositório"

Sessão: <home>/sessions/<workspace>/<id>/session.v4.jsonl.zstd
Home:   OPEN_HARNESS_HOME (ou OHSH_HOME), por omissão ~/.open-harness
`

/** Versão lida do `package.json` da app (best-effort). */
export function readVersion(): string {
  try {
    const pkg = join(cliPackageRoot(), 'package.json')
    if (!existsSync(pkg)) return '0.0.0'
    const raw = JSON.parse(readFileSync(pkg, 'utf8')) as { version?: string }
    return raw.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

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
      profile: args.profile,
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
