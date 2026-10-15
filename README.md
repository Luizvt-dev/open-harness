# Open Harness (dsh) — Recriação

Recriação do **DeepSeek Harness** a partir do documento de análise
`DeepSeek Harness - Plano de Recriacao.md`. Monorepo funcional que segue o
sistema do dsh: **kernel de plugins (cordis) + composição declarativa de
perfis por camadas de patch YAML**.

> **Escopo desta entrega: Fase 0 + Fase 1 + Fase 2** do plano (fundação,
> kernel de perfis/composição e núcleo do agente com a CLI `dsh`). As fases
> seguintes (superfície web, shell desktop, runtime embarcado, paridade
> avançada) estão no roadmap.

## Estado

| Fase | Estado |
| ---- | ------ |
| 0 — Fundação (monorepo, kernel DI, loader, testes/CI) | ✅ concluída |
| 1 — Perfis e composição (bundles, patch YAML, HMR) | ✅ concluída |
| 2 — Núcleo do agente (LLM, tools, loop, sessão, CLI) | ✅ concluída |
| 3 — Superfície Web + transporte | ⏳ planeada |
| 4 — Shell Desktop (Electron) | ⏳ planeada |
| 5 — Runtime embarcado + Skills Office | ⏳ planeada |
| 6 — Paridade avançada e operação | ⏳ planeada |

## Arranque rápido

```bash
pnpm install       # liga os pacotes do workspace
pnpm check         # typecheck (build + testes) e 210 testes
pnpm test          # só os testes
pnpm build         # tsc -b de todos os pacotes (composite)

# CLI (precisa da chave para correr com o modelo real)
pnpm dsh --profile headless "crie um README"
pnpm dsh --offline -v "crie um README"   # sem rede: exercita tools + sessão
```

Requer Node ≥ 24 e pnpm 12. A chave vai em `DEEPSEEK_API_KEY`; o home de
dados em `OPEN_HARNESS_HOME` (default `~/.open-harness`).

## Estrutura

```
packages/
  kernel/
    cosmokit/             # utils (Deferred, isPlainObject, noop, …)
    schemastery/          # validação de esquemas (s.object/string/union/…)
    cordis/               # kernel DI: Context, fibras, plugin(), dispose
    cordis-plugin-loader/ # PluginLoader: linhas → módulos → fibras, diff HMR
  boot/
    home-paths/           # resolveDshHome()/dshHomePath()/getHomePaths()
    profile-boot/         # parsePatch (!!js) + composeProfile (camadas)
    app-boot/             # bootApp(): compõe → carrega → política → reload
    hmr/                  # Hmr: reload serializado + fs.watch + debounce
  llm/
    dsh-llm/              # tipos Anthropic-like, erros, retry/backoff,
                          # TokenMeter, LlmClient, collectStream, coalesceText
    dsh-llm-deepseek/     # DeepSeekAdapter (fetch injectável) + SSE + catálogo
  session/
    dsh-session-format/   # v4 canónico + migrações v0..v3 documentadas
    dsh-session/          # Session, encodeWorkspace, caminhos de ficheiro
    dsh-session-persistence-jsonl/  # frames <crc32>$<base64> + zstd + torn-tail
  agent/
    dsh-tools/            # ToolRegistry, restrict, toLlmTools, execute tipado
    dsh-tool-fs/          # read/write/edit (mkdir do directório-pai)
    dsh-tool-fs-search/   # glob/grep + globToRegExp
    dsh-tool-bash/        # bash/pwsh por plataforma, timeout, AbortSignal
    dsh-agent-loop/       # AgentLoop: checkpoint antes de cada request
    dsh-agent/            # plugin cordis: publica o serviço `agent`
apps/
  dsh/                    # CLI `dsh`: perfis, overlay de runtime, modo offline
```

### O kernel (cordis)

- **Serviços** vivem no registry global da raiz, com propriedade por fibra.
- **Single-slot por omissão**: dois provedores do mesmo serviço lançam
  `ServiceConflictError` (use `provide({ multiple: true })` para múltiplos).
- **Activação por disponibilidade**: um plugin só activa quando todos os
  serviços que injecta estão registados — a ordem das linhas é irrelevante.
- **Dispose**: evento `dispose` → filhos LIFO → efeitos LIFO → desanexa do pai.

### Composição de perfis (profile-boot)

Um perfil é uma árvore de camadas, compostas nesta ordem:

```
bundles (ordem do manifesto) → cordis.patch.yml do perfil → home → overlays (--patch)
```

Regras:

- **último-por-id vence** por chave, mantendo a posição de primeira aparição;
- `config` é **substituído por inteiro** quando a camada o declara (nunca
  merge em fundo); `config:` vazio/`null` reseta para `{}`;
- metadados (`plugin`, `enabled`, `order`, `group`, `isolate`, `requires`)
  só mudam se declarados explicitamente;
- o `requireDir` acompanha a camada que declarou o `plugin` (layout pnpm: os
  plugins vivem no `node_modules` do bundle, não do perfil);
- o manifesto do perfil (`package.json` → `dsh.profile.bundles`) lista os
  bundles; entradas `{ name, required: false }` são opcionais (`onSkip`).

### Patch YAML e `!!js`

```yaml
# cordis.patch.yml
hot:
  plugin: ./hot-plugin.mjs   # string = atalho para plugin
  config:
    value: !!js process.platform == 'win32' ? 'win' : 'unix'
off:
  plugin: ./algo.mjs
  enabled: false             # saltado, reportado como 'disabled'
cfg-only:
  plugin: null               # linha só-de-config ('config-only')
```

As expressões `!!js` são avaliadas **no boot** (não em compilação) no escopo
global — os ficheiros de patch são configuração local de confiança.

### HMR (critério de aceite da Fase 1)

`Hmr` serializa reloads (nunca em paralelo) e agrega (*coalescing*) os
triggers que chegam durante um reload activo. `PluginLoader.update()` faz o
diff por assinatura + fingerprint de config:

- só a config mudou e o plugin tem `reconfigure` → **actualização quente**
  (sem reiniciar a fibra);
- plugin/grupo/inject mudaram ou não há `reconfigure` → reinício da linha;
- linhas removidas/desabilitadas → dispose.

Ou seja: **escrever no `cordis.patch.yml` altera configs sem reiniciar o
processo**.

## Núcleo do agente (Fase 2)

### LLM

- `dsh-llm` — contrato Anthropic-like (`LlmMessage`/`ContentBlock`/
  `LlmRequest`/`LlmResponse`), erros tipados (`LlmAbortedError`,
  `LlmNetworkError`, `LlmTimeoutError`, `errorFromStatus`), retry com backoff,
  `TokenMeter` e `LlmClient` (retry + `collectStream` + `coalesceText`).
- `dsh-llm-deepseek` — `DeepSeekAdapter` sobre `fetch` injectável, endpoint
  `https://api.deepseek.com/anthropic`, SSE próprio (`SseParser`), catálogo
  `deepseek-flash` / `deepseek-v4-pro`. **Não** usamos o SDK da Anthropic.

### Sessão

- Formato **v4 canónico**; v0–v3 são reconstruções documentadas
  (`KNOWN_VERSIONS`, `MIGRATIONS`, `migrateToCurrent`).
- Persistência em frames `<crc32>$<base64>` — o CRC32 (nativo) cobre o payload
  **já comprimido** com o Zstd também nativo; um corte abrupto deixa só o
  último frame incompleiro, descartado no load (*torn-tail*).
- Caminho: `<home>/sessions/<workspace>/<session-id>/session.v4.jsonl.zstd`,
  com `encodeWorkspace` a trocar `\` e `:` por `-`.

### Loop e tools

- `AgentLoop` faz **checkpoint + persistência antes de cada request**; um erro
  de tool vira `isError` sem abortar o turno; `maxStepsPerTurn` sinaliza
  `stoppedByLimit`.
- `ToolRegistry.execute` devolve `{ok:true,result}` ou `{ok:false,error}` —
  nunca propaga um throw da tool para fora do loop.
- O `tool_result` grava em `toolUseId` **o id do bloco `tool_use`** (não o nome
  da tool): é o que volta ao wire como `tool_use_id` no passo seguinte.

### CLI `dsh` (critério de aceite da Fase 2)

```bash
pnpm dsh --profile headless "crie um README"
```

1. materializa `~/.open-harness/profiles/headless` apontando ao bundle
   `apps/dsh/bundles/headless` (manifesto gerado, idempotente);
2. escreve `~/.open-harness/runtime/overlay.yml` com as sobrescritas da
   linha de comandos (`--home/--model/--system/--cwd`) — overlay porque só
   declara `config:`, deixando o `requireDir` da linha no bundle;
3. `bootApp` compõe `bundles → perfil → home → overlay` e aplica as linhas no
   cordis: `agent` (plugin `dsh-agent`) e `cli-tools` (com `requires: ['agent']`);
4. resolve o serviço `agent` e corre um turno — tools reais, sessão persistida
   em zstd — e imprime a resposta final.

`--offline` troca o transporte por um `ScriptedAdapter` determinístico (escreve
o `README.md` e fecha o turno), para exercitar o pipeline inteiro sem rede.

## Decisões conscientes (divergências do plano)

- **Home de dados**: `OPEN_HARNESS_HOME` / `OHSH_HOME` → default
  `~/.open-harness`. **Não lê `DSH_HOME`** de propósito, para não colidir com
  um DeepSeek Harness real instalado na mesma máquina.
- **Escopo npm**: `@open-harness/*`, mantendo os nomes de pacotes do sistema
  original (`cosmokit`, `schemastery`, `cordis`, `cordis-plugin-loader`,
  `home-paths`, `profile-boot`, `app-boot`, `hmr`), com implementação própria.
- Stack: TypeScript 7 (nativo), Vitest 5, pnpm workspaces, ESM estrito.

## Roadmap (Fases 3–6, resumo do plano)

- **Fase 3 — Superfície Web + transporte**: UI web do harness, transporte
  (IPC/streaming) entre host e renderer.
- **Fase 4 — Shell Desktop**: Electron com fuses endurecidos, preload mínimo.
- **Fase 5 — Runtime embarcado + Skills Office**: runtime incorporado e skills
  de documentos Office.
- **Fase 6 — Paridade avançada e operação**: telemetria, actualização,
  hardening e paridade restante com o dsh observado.
- Continua por criar em Fase 2: `dsh-system-prompt`/`dsh-persona` (hoje o
  system prompt vive no bundle `headless`) e mais tools do catálogo.

## Testes

`pnpm check` corre typecheck de build, typecheck dos testes e a suite inteira
(**210 testes / 20 ficheiros**): kernel (cordis, loader), composição
(profile-boot), arranque (app-boot), HMR (unit + integração — critério de
aceite da Fase 1), home-paths, LLM (`dsh-llm`, `dsh-llm-deepseek`), sessão
(formato, `Session`, persistência zstd), tools (`dsh-tools`, fs, search, bash),
loop (`dsh-agent-loop`) e a **CLI `dsh`** — incluindo o teste de aceite da
Fase 2 que corre `dsh --profile headless "crie um README"` de ponta a ponta e
verifica a tool executada, o `session.v4.jsonl.zstd` e a resposta final.
