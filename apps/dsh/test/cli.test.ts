import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { afterAll, describe, expect, it } from 'vitest'
import { sessionToMessages } from '@open-harness/dsh-agent-loop'
import {
  UsageError,
  ensureProfile,
  headlessBundleDir,
  parseArgs,
  readVersion,
  runCli,
  writeRuntimeOverlay,
} from '@open-harness/dsh-cli'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const temps: string[] = []

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}

afterAll(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true })
})

/** Todos os `session.v4.jsonl.zstd` sob `home`. */
async function findSessionFiles(home: string): Promise<string[]> {
  const entries = await readdir(home, { recursive: true })
  return entries
    .filter((entry): entry is string => typeof entry === 'string')
    .filter((entry) => entry.endsWith('session.v4.jsonl.zstd'))
    .map((entry) => join(home, entry))
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  it('separa opções de posicionais e junta o prompt', () => {
    const args = parseArgs(['--profile', 'headless', 'crie', 'um', 'README'])
    expect(args.profile).toBe('headless')
    expect(args.prompt).toBe('crie um README')
    expect(args.offline).toBe(false)
  })

  it('aceita atalhos e valor em `--chave=valor`', () => {
    const args = parseArgs(['-m=deepseek-v4-pro', '-C', 'C:\\repo', 'ola'])
    expect(args.model).toBe('deepseek-v4-pro')
    expect(args.cwd).toBe('C:\\repo')
    expect(args.prompt).toBe('ola')
  })

  it('`--` termina o parsing de opções', () => {
    const args = parseArgs(['--', '--não-é-opção'])
    expect(args.prompt).toBe('--não-é-opção')
  })

  it('lança UsageError para opção desconhecida', () => {
    expect(() => parseArgs(['--nope'])).toThrow(UsageError)
  })

  it('lança UsageError quando falta o valor de uma opção', () => {
    expect(() => parseArgs(['--model'])).toThrow(/requires a value/)
  })
})

// ---------------------------------------------------------------------------
// runCli: superfície de saída
// ---------------------------------------------------------------------------

describe('runCli (superfície)', () => {
  it('`--help` sai a 0 e mostra o uso', async () => {
    const out: string[] = []
    const code = await runCli(['--help'], { out: (line) => out.push(line), log: () => {} })
    expect(code).toBe(0)
    expect(out.join('\n')).toContain('dsh [opções] <prompt>')
  })

  it('`--version` sai a 0 com a versão do package.json', async () => {
    const out: string[] = []
    const code = await runCli(['--version'], { out: (line) => out.push(line), log: () => {} })
    expect(code).toBe(0)
    expect(out.join('')).toBe(readVersion())
    expect(out.join('')).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('sem prompt sai a 2', async () => {
    const log: string[] = []
    const code = await runCli([], { out: () => {}, log: (line) => log.push(line) })
    expect(code).toBe(2)
    expect(log.join('\n')).toContain('falta o prompt')
  })

  it('opção desconhecida sai a 2', async () => {
    const log: string[] = []
    const code = await runCli(['--nope', 'x'], { out: () => {}, log: (line) => log.push(line) })
    expect(code).toBe(2)
    expect(log.join('\n')).toContain('unknown option')
  })
})

// ---------------------------------------------------------------------------
// Perfil e overlay
// ---------------------------------------------------------------------------

describe('ensureProfile', () => {
  it('materializa o perfil headless apontando ao bundle embutido', async () => {
    const home = await tempDir('dsh-home-')
    const first = ensureProfile({ homeDir: home })
    expect(first.existed).toBe(false)

    const manifest = JSON.parse(await readFile(join(first.profileDir, 'package.json'), 'utf8')) as {
      dsh: { profile: { bundles: { path: string }[] } }
    }
    expect(manifest.dsh.profile.bundles[0]!.path).toBe(headlessBundleDir())
    expect(existsSync(join(manifest.dsh.profile.bundles[0]!.path, 'cordis.patch.yml'))).toBe(true)

    const second = ensureProfile({ homeDir: home })
    expect(second.existed).toBe(true)
    expect(second.profileDir).toBe(first.profileDir)
  })

  it('recusa perfis que não sejam materializados pela CLI', async () => {
    const home = await tempDir('dsh-home-')
    expect(() => ensureProfile({ homeDir: home, name: 'inexistente' })).toThrow(/profile not found/)
  })
})

describe('writeRuntimeOverlay', () => {
  it('escreve a camada de overlay com `agent.config`', async () => {
    const home = await tempDir('dsh-home-')
    const file = writeRuntimeOverlay(home, { model: 'deepseek-v4-pro', cwd: home })

    const doc = parseYaml(await readFile(file, 'utf8')) as {
      agent: { config: Record<string, unknown> }
    }
    expect(doc.agent.config.model).toBe('deepseek-v4-pro')
    expect(doc.agent.config.homeDir).toBe(home)
    expect(doc.agent.config.cwd).toBe(home)
  })

  it('nunca declara `plugin` (o requireDir tem de ficar no bundle)', async () => {
    const home = await tempDir('dsh-home-')
    const file = writeRuntimeOverlay(home, {})
    const doc = parseYaml(await readFile(file, 'utf8')) as Record<string, unknown>
    expect(doc).toEqual({ agent: { config: expect.any(Object) } })
    expect(Object.keys(doc)).not.toContain('plugin')
  })
})

// ---------------------------------------------------------------------------
// Aceite da Fase 2: `dsh --profile headless "crie um README"`
// ---------------------------------------------------------------------------

describe('dsh --profile headless (aceitação)', () => {
  it('corre de ponta a ponta em modo offline: tools, sessão e resposta', async () => {
    const home = await tempDir('dsh-home-')
    const cwd = await tempDir('dsh-cwd-')

    const out: string[] = []
    const log: string[] = []
    const code = await runCli(
      [
        '--offline',
        '--profile',
        'headless',
        '--home',
        home,
        '--cwd',
        cwd,
        '--verbose',
        'crie um README',
      ],
      { out: (line) => out.push(line), log: (line) => log.push(line) },
    )

    const diagnostics = log.join('\n')
    expect(code, diagnostics).toBe(0)

    // 1. a tool `write` correu mesmo (fs verdadeiro, no cwd pedido)
    expect(existsSync(join(cwd, 'README.md'))).toBe(true)
    expect(await readFile(join(cwd, 'README.md'), 'utf8')).toContain('crie um README')

    // 2. a sessão foi persistida em zstd na casa canónica
    const sessions = await findSessionFiles(home)
    expect(sessions, `sem sessão em ${home}\n${diagnostics}`).toHaveLength(1)
    expect(sessions[0]).toContain('session.v4.jsonl.zstd')

    // 3. a resposta final foi imprimida no stdout
    expect(out.join('\n')).toContain('README.md escrito')

    // 4. diagnóstico do turno em stderr
    expect(diagnostics).toContain('tool       write')
    expect(diagnostics).toContain('sessão')
    expect(diagnostics).toContain('passos')
  })

  it('a sessão persistida é v4 e recuperável pelo loader', async () => {
    const home = await tempDir('dsh-home-')
    const cwd = await tempDir('dsh-cwd-')

    const code = await runCli(['--offline', '--home', home, '--cwd', cwd, 'crie um README'], {
      out: () => {},
      log: () => {},
    })
    expect(code).toBe(0)

    const [file] = await findSessionFiles(home)
    expect(file).toBeDefined()

    const { loadSession } = await import('@open-harness/dsh-session-persistence-jsonl')
    const loaded = await loadSession(file!)
    expect(loaded.header.version).toBe(4)
    expect(loaded.header.cwd).toBe(cwd)
    expect(loaded.droppedFrames).toBe(0)

    const types = loaded.records.map((record) => record.type)
    expect(types[0]).toBe('message')
    expect(loaded.records[0]!.role).toBe('user')
    expect(types).toContain('tool_result')

    // O `tool_use` fica embutido na mensagem do assistente…
    const assistant = loaded.records.find((record) => record.type === 'message' && record.role === 'assistant')
    const toolUse = assistant?.content?.find((block) => block.type === 'tool_use')
    expect(toolUse, JSON.stringify(loaded.records, null, 2)).toBeDefined()

    // …e o `tool_result` tem de referenciar EXATAMENTE esse id: é o que volta
    // ao wire como `tool_use_id` no passo seguinte.
    const toolResult = loaded.records.find((record) => record.type === 'tool_result')
    expect(toolResult?.toolUseId).toBe(toolUse!.id)
    expect(toolResult?.isError).toBe(false)

    const messages = sessionToMessages(loaded.records)
    const echoed = messages
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .find((block) => block.type === 'tool_result')
    expect(echoed?.tool_use_id).toBe(toolUse!.id)
  })
})
