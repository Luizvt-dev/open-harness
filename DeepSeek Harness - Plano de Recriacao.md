# DeepSeek Harness (`dsh`) — Análise e Plano de Recriação

> Documento gerado por engenharia reversa do artefato instalado na máquina do usuário.
> Toda afirmação está marcada como **[observado]**, **[inferido]** ou **[desconhecido]**.
> Fontes: REA (MCP) sobre os artefatos shipped + leitura direta dos arquivos empacotados.

---

## 0. Resumo executivo

O atalho `C:\Users\Vortex\Desktop\DeepSeek Harness.lnk` aponta para:

```
C:\Users\Vortex\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe
Descrição do atalho: "Electron desktop shell for a bundled dsh runtime and external plugins"
```

O alvo é o **DeepSeek Harness**, um **harness de agente de código** (categoria do Claude Code / OpenAI Codex CLI / OpenCode), distribuído como **aplicação desktop Electron** que embarca:

1. Um **shell Electron** (janela, bandeja, atualizador automático).
2. Um **runtime de agente em Node.js** chamado **`dsh`**, altamente modularizado em **289 pacotes** `@deepseek-ai/*` sobre um framework de injeção de dependência/plugins próprio (**Cordis**).
3. Um **frontend Web em React 18 + Vite** servido localmente, com um **sistema de plugins no navegador**.
4. Um **runtime portátil embarcado**: Node 24.x, pnpm 11.x, Python 3.12.x (com numpy/pandas/python-docx/pptx/openpyxl).
5. **Skills de Office** (docx/pptx/xlsx) com LibreOffice embarcado, **STT** (sherpa-onnx), ripgrep, sharp, node-pty, etc.

**Recomendação de estratégia de recriação:** reconstruir em **duas trilhas paralelas** — (A) um *core* de agente mínimo (MVP funcional em ~6–10 semanas de uma equipe pequena) e (B) a fidelidade completa do produto (meses de equipe). O plano abaixo define ambos.

---

## 1. Identidade e evidências do alvo

| Item | Valor | Tipo |
|---|---|---|
| Caminho do executável | `C:\Users\Vortex\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe` | observado |
| SHA-256 do `.exe` | `df4e91fd91f6f1bee19a1990b0e167bfe06abf8353279d82bbb8e60edb6ba0d3` (244.481.512 bytes) | observado (REA) |
| Versão Electron | `44.0.0` (arquivo `version`) | observado |
| Versão do app | `0.2.0-rc.2` | observado |
| App ID | `com.deepseek.dsh` | observado |
| Build commit | `04f392c9ddd144fa426da2045178797da6db6c11` (`dshBuildDirty: false`) | observado |
| Canal de update | `nightly` | observado |
| Feed de update | `https://download.deepseek.com/dsh-desk/feeds/win-x64/` | observado |
| Publisher (assinatura) | `CN=Hangzhou DeepSeek Artificial Intelligence Co., Ltd., C=CN` | observado |
| Protocolo host↔shell | `hostProtocolVersion: 4` | observado |
| Porta do host Web | `19387` (loopback) | observado |
| Home de dados | `%USERPROFILE%\.dsh` (`$DSH_HOME` sobrescreve) | observado |
| Licença declarada | MIT | observado |
| Repositório declarado | `https://github.com/deepseek-ai/deepseek-harness` | observado (campo `repository` dos package.json) |

### Fuses do Electron (REA — `inspect_electron_fuses`)

| Fuse | Estado | Implicação |
|---|---|---|
| `RunAsNode` | **enabled** | O `.exe` roda como Node puro (usado pelo `ELECTRON_RUN_AS_NODE`) |
| `EnableNodeOptionsEnvironmentVariable` | **enabled** | `NODE_OPTIONS` é honrado |
| `EnableNodeCliInspectArguments` | **enabled** | `--inspect` funciona (debug) |
| `EnableCookieEncryption` | disabled | Cookies não cifrados |
| `EnableEmbeddedAsarIntegrityValidation` | disabled | **Sem** validação de integridade do ASAR |
| `OnlyLoadAppFromAsar` | disabled | Carrega app de fora do ASAR |
| `GrantFileProtocolExtraPrivileges` | enabled | Privilégios extras em `file://` |
| `WasmTrapHandlers` | enabled | |

> Evidência: `ev_2ae5ef99cefdb5d2ab17427d9af01d4aa39e14e21ce0a8e34e59f9e1d4b2fcf5`

### Evidências REA utilizadas

| Evidência | Operação | Resultado |
|---|---|---|
| `ev_2ae5ef99…b2fcf5` | `inspect_electron_fuses` | Fuses acima |
| `ev_7bd050bc…fecc4e` | `analyze_javascript_application` (dir `lib/`) | 7 arquivos, 123.510 nós AST, 4 BrowserWindows, 20 webPreferences, 11 `contextBridge` APIs, 27 membros expostos, 91 operações IPC (83 canais dinâmicos, 35 handlers no main) |
| `ev_3eab6d34…be953` | (parent) | Grafo semântico completo |
| `ev_fb9b3695…a2693ed` | `analyze_javascript_application` (app.asar inteiro) | **Parcial**: orçamento de memória esgotado (121 MB c/ `node_modules`); análise interrompida em `zod/v4/mini/external.js` |

> **Limitação registrada:** a análise estática do ASAR inteiro não completou por limite de memória do worker (1 GiB). O trabalho foi refeito de forma direcionada (extração seletiva + leitura dos READMEs empacotados).

---

## 2. Arquitetura observada

### 2.1 Visão de camadas

```
┌──────────────────────────────────────────────────────────────────────┐
│  CAMADA 5 — Shell Desktop (Electron 44)                              │
│  resources/app.asar/lib/main.js  (+ preloads CJS)                    │
│  Janela, Tray, Menu, electron-updater, atalhos, IPC com o Host       │
└───────────────────────────┬──────────────────────────────────────────┘
                            │ spawn (stdio: ipc)  ELECTRON_RUN_AS_NODE=1
                            │ --expose-internals <runtimeDir>/node_modules/
                            │   @deepseek-ai/dsh-desktop-host/lib/index.js
                            │   <runtimeDir> <projectDir> <primaryRuntime> ...
                            ▼
┌──────────────────────────────────────────────────────────────────────┐
│  CAMADA 4 — Desktop Host (processo Node filho)                       │
│  @deepseek-ai/dsh-desktop-host                                       │
│  loadProfileDirectory → runProfile({profile:"desktop",               │
│     args:["--no-open","--port","19387"]})                            │
│  → envia {type:"ready", url, injections} ao shell                    │
└───────────────────────────┬──────────────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────────────────┐
│  CAMADA 3 — Runtime de Agente `dsh` (Node 24, ESM)                   │
│  Cordis (DI + plugins) · perfis · bundles · tools · sessão · LLM     │
│  289 pacotes @deepseek-ai/* no perfil de runtime                     │
└───────────────────────────┬──────────────────────────────────────────┘
                            │ Typert Remote (WebSocket mux) + HTTP /api
                            ▼
┌──────────────────────────────────────────────────────────────────────┐
│  CAMADA 2 — Frontend Web (React 18 + Vite)                           │
│  @deepseek-ai/dsh-web-frontend/dist + 60+ plugins de UI              │
│  dsh-client-modules (window.__DSH_BOOT__) · ui-slots · ui-dockkit    │
└──────────────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────────────┐
│  CAMADA 1 — Runtime Embarcado (fora do ASAR)                         │
│  node 24.21.0 · pnpm 11.7.0 · python 3.12.14 · LibreOffice           │
│  sherpa-onnx (STT) · ripgrep · sharp · node-pty · ffmpeg.dll         │
└──────────────────────────────────────────────────────────────────────┘
```

### 2.2 Fluxo de boot (observado em `lib/main.js` e `dsh-desktop-host/lib/index.js`)

1. `main.js` localiza `runtimeDir` (pacotes imutáveis) e `projectDir` (perfil = `~/.dsh/profiles/desktop`) e faz `spawn`:

   ```js
   spawn(node, ["--expose-internals", ...inspectArg,
     `${runtimeDir}/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js`,
     runtimeDir, projectDir, primaryRuntime, pnpmEntry, nodeBin],
     { cwd: projectDir, stdio: ["ignore","pipe","pipe","ipc"], env: {ELECTRON_RUN_AS_NODE:"1",...} })
   ```

2. O Host carrega o **perfil `desktop`** e sobe o **app Web** em `127.0.0.1:19387` com `--no-open`.
3. O Host envia ao shell, via IPC:

   ```js
   { type: "ready", url: <url autenticada com token>, injections: [...rows de <head>] }
   ```

4. O shell cria a `BrowserWindow` e carrega essa URL (com token de sessão). O shell também recebe eventos `platform-session`, `shutdown-complete`, `quit-inspection`, `update-tasks`.
5. Encerramento: shell pede `shutdown` → Host roda `shutdown.shutdown(0)` → responde `shutdown-complete` → `disconnect`.

### 2.3 Composição por plugins (Cordis) — o núcleo conceitual

O sistema **não** é um monólito com módulos fixos. É uma **árvore de plugins** composta por **camadas de patch**:

- Um **perfil** = diretório com `package.json` (que declara `dsh.profile.bundles`) + `cordis.patch.yml` (overrides do usuário).
- Ordem de composição (último vence por `id`):
  1. cada **bundle** listado em `dsh.profile.bundles`, na ordem;
  2. o `cordis.patch.yml` do perfil;
  3. o `$DSH_HOME/cordis.patch.yml` (nível home);
  4. overlays `--patch`.
- Uma entrada de patch **substitui o bloco `config` inteiro** do alvo (sem merge profundo).
- Expressões `!!js` permitem lógica no momento do boot (ex.: `process.platform === 'win32'`).
- Ativação é **orientada à disponibilidade de serviços**, não à ordem das linhas.

**Perfil `desktop` do usuário** (observado em `~/.dsh/profiles/desktop/package.json`):

```json
{
  "name": "dsh-profile-desktop", "private": true,
  "dependencies": {
    "billion-context": "^0.1.192", "dsh-better-sidebar": "^0.25.0",
    "dsh-free-search": "^0.8.6", "dsh-genui": "^0.3.1",
    "dsh-mcp-connector": "^0.2.70", "dsh-rewind": "^0.11.12"
  },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } }
}
```

> **[observado]** O app suporta **plugins de terceiros** versionados via pnpm dentro do perfil (aqui: `dsh-better-sidebar`, `dsh-free-search`, `dsh-genui`, `dsh-mcp-connector`, `dsh-rewind`, `billion-context`). O override do usuário em `cordis.patch.yml` ajusta `ui-settings-account`, `ui-chat`, `ui-settings`.

### 2.4 Os dois bundles shipped

**`@deepseek-ai/dsh-base`** (`cordis.patch.yml`, ~529 linhas) — o *core* compartilhado. Row-groups principais:

| Grupo | Rows representativas |
|---|---|
| Infra/DI | `timer` (cordis-plugin-timer), `hmr` (dsh-hmr), `typert`, `typert-loader`, `typert-gateway` |
| LLM | `llm`, `llm-deepseek`, `llm-deepseek-api-key`, `llm-deepseek-account`, `llm-pi-ai` (multi-provider dormente), `llm-retry`, `deepseek-llm-api-extensions` |
| Modelo padrão | `agent-default-model` → `provider: deepseek-official`, `model: deepseek-flash` |
| Sessão | `session`, `session-persistence-jsonl` (root `$DSH_HOME/sessions`), `session-query-sqlite`, `session-projection`, `session-projection-cache`, `session-title`, `session-checkpoint-policy`, `session-telemetry-otel` |
| Storage | `storage`, `storage-json` (`$DSH_HOME/storages`), `storage-domain` |
| Agente | `agent`, `agent-loop`, `agent-instructions`, `system-prompt`, `persona` |
| Tools FS | `tool-fs` (read/write/edit/read_image), `tool-fs-search` (glob/grep) |
| Shell | `bash-sandbox` + `tool-bash` (POSIX) / `pwsh-sandbox` + `tool-pwsh` (win32) |
| Sandbox/Permissão | `sandbox-local`, `sandbox-policy` (`workspace-write`), `user-approval` (`ask`), `permission-presets` (`read-only`/`workspace-write`/`danger-full-access`) |
| Subagentes | `subagent`, `subagent-spawn-in-process`, `subagent-fork-in-process`, `tool-subagent`, `tool-subagent-fork`, `tool-subagent-control` |
| Web tools | `web` (search deepseek-official + fetch http), `web-search-deepseek`, `web-fetch-http`, `tool-web` |
| Outros | `jobs-local`, `goal`, `goal-round-driver`, `command-goal`, `plan-mode`, `token-meter`, `compaction-basic`, `compaction-tool-result-pruner`, `compaction-image-offload`, `tool-todo`, `tool-ask-user`, `tool-skill`, `skill`, `skill-filesystem`, `spill-local`, `spill-policy`, `ptc-runtime-node`, `workflow-ptc`, `tool-workflow`, `tool-ralph` (off), `repeat-tool-reminder`, `mcp-resources`, `config-editor`, `settings`, `plugin-manager`, `authorization`, `credentials-local`, `deepseek-account-platform` |

**`@deepseek-ai/dsh-web-app`** (`cordis.patch.yml`, ~565 linhas) — a superfície navegador. Destaques:
- `system-prompt` ganha `personaPrefix`/`personaSuffix` ("You are a coding agent powered by the {{model}} model." / "Your working directory is {{cwd}}.").
- **Transporte**: `webserver` (`127.0.0.1:3080` fallback), `web-startup`, `web-runtime`, `connection` (client-connection), `api-remotes`, `modules` (client-modules), `file-upload`, `client-hmr`.
- **~60 rows `ui-*`** que são plugins de UI do navegador (sidebar, chat, conversation, tool, trajectory, settings-*, plugin-manager, etc.).
- **Controllers (Typert Remote)**: `session-controller`, `job-controller`, `terminal-controller`, `workspace-controller`, `workspace-files`, `settings-controller`, `account-controller`.
- **Presets de agente**: `presets/standard.patch.yml`, `ptc`, `minimal`, `cordis` + `agent-preset-registry` (default `standard`).
- **Deslocamento do "plano do agente" para presets**: muitas rows do base são desabilitadas na web (`tool-bash`, `tool-fs`, `tool-web`, `tool-subagent*`, `compaction`, `plan-mode`, …) e cada **sessão monta seu preset**, que declara seu próprio conjunto de tools/prompt.

### 2.5 Preset de agente `standard` (observado)

Um `@deepseek-ai/dsh-agent-preset` com `id: standard`, `order: 1`, e `config.plugins` = lista de tools/prompt do agente, agrupadas em `cordis:group` (com `isolate`):
- persona, agent-instructions
- tool-bash/tool-pwsh (por plataforma), tool-fs, tool-fs-search, tool-jobs
- skill-filesystem, tool-skill
- command-goal, tool-goal
- grupo `planning` (plan-mode)
- grupo `compaction` (compaction-basic, command-compact, tool-result-pruner)
- grupo `delegation` (tool-subagent-control, list-agents, tool-subagent spawn, tool-subagent_fork, workflow-ptc, tool-workflow, tool-ralph off)
- tool-ask-user, tool-todo, tool-web, present

### 2.6 Catálogo de tools (observado)

| Pacote | Nomes de tool registrados |
|---|---|
| `dsh-tool-fs` | `read`, `write`, `edit`, `read_image` |
| `dsh-tool-fs-search` | `glob`, `grep` |
| `dsh-tool-bash` / `-persistent` | `bash` |
| `dsh-tool-pwsh` / `-persistent` | `pwsh` |
| `dsh-tool-todo` | `todo_write` |
| `dsh-tool-ask-user` | `ask_user_question` |
| `dsh-tool-web` | `web_fetch`, `web_search` |
| `dsh-tool-skill` | `skill` |
| `dsh-tool-goal` | `create_goal`, `get_goal`, `update_goal` |
| `dsh-tool-jobs` | `job_list`, `job_kill`, `job_output` |
| `dsh-tool-subagent-control` | `send_message`, `interrupt_agent` (+ `list_agents`) |
| `dsh-tool-subagent` | `subagent`, `subagent_fork`, `list_subagent_models` |
| `dsh-tool-workflow` | (workflow) |
| `dsh-tool-ralph` | `ralph` (desabilitado por padrão) |
| `dsh-tool-present` | `present` |
| `dsh-tool-str-replace-editor` | `str_replace_editor` (opt-in) |
| `dsh-tool-cordis` | `cordis_inspect_list`, `cordis_inspect_query` |
| `dsh-tool-workspace-dependencies` | `load_workspace_dependencies` |
| `dsh-tools` (PTC) | `run_code` (modo PTC / programmatic tool calling) |

### 2.7 Modelo de dados de sessão (observado)

- Local: `~/.dsh/sessions/<workspace-codificado>/session-<uuid>/session.v4.jsonl.zstd`
  - `workspace-codificado` = caminho com `\`/`:` trocados por `-` (ex.: `--C-Users-Vortex-Downloads-Teste--`).
- Primeiro registro (header):
  ```json
  {"type":"session","version":4,"id":"session-<uuid>","createdAt":<ms>,"cwd":"...",
   "parentSession":null,"isSeeded":false,"delegationDepth":0,"agentPreset":"standard"}
  ```
- Sessões de subagente carregam `origin:"subagent"`, `parentSession`, `delegationDepth`.
- Persistência: **framing próprio** com **frames Zstandard com checksum** (`dsh-session-persistence-jsonl`); `compression:'none'` produz JSONL texto puro. Suporta migração de formatos **v0→v1→v2→v3→v4** (pacotes `dsh-session-format-vN-to-vN+1`) e **recoverable torn-tail**.
- Demais dados em `~/.dsh`: `storages/` (`mcp_connector.json` 363 KB, `workspace.json`), `attachments/v1/`, `rewind-git/`, `.credentials.yaml`, `.anonymous-user-id`, `profiles/`.

### 2.8 LLM / provider (observado)

- Endpoint: `https://api.deepseek.com/anthropic` (API **compatível com Anthropic**; usa `@anthropic-ai/sdk`). Busca web usa `https://api.deepseek.com/anthropic/v1`.
- Modelos default (catálogo advisory): `deepseek-flash` (**DeepSeek-V41-Flash**, texto+imagem, `contextWindow` 1e6) e `deepseek-v4-pro` (**DeepSeek-V4-Pro**).
- Defaults: `contextWindow` 1.000.000; `maxTokens` 256.000; idle timeout de stream 300 s; imagens via Files API.
- Multi-provider opcional: `@deepseek-ai/dsh-llm-pi-ai` (rotas dormentes até config), SDKs OpenAI/Google presentes.
- Contabilização de tokens de imagem própria (patch 14 px, downscale 3:1, teto 1024 tokens/imagem).

### 2.9 Superfície de IPC do Electron (observado por REA)

- 4 `BrowserWindow` (janela principal + welcome + mandatory-update + update-dialog/login).
- 11 APIs `contextBridge`, 27 membros expostos; preloads: `preload-app.cjs`, `preload-mandatory.cjs`, `preload-platform-account.cjs`, `preload-update-dialog.cjs`, `preload-welcome.cjs`.
- 91 operações IPC, sendo 83 com nome de canal dinâmico (canais em mapa `DESKTOP_IPC.*`), 35 `ipcMain.handle`, 44 transmissões do renderer.
- 22 observações de validação de sender.
- Recursos: Tray (Windows), atalhos globais (`keybindings.json` no `userData`), `powerMonitor`, `nativeTheme`, `protocol`, `session`, `shell`, `clipboard`, `dialog`, `Notification`.

### 2.10 Runtime embarcado (observado)

| Componente | Versão | Papel |
|---|---|---|
| Node | 24.18.1 (`runtime/versions.json`) / 24.21.0 (`primary-runtime`) | Executa o agente, shells, MCP |
| pnpm | 11.7.0 | Instalar/manter plugins do perfil |
| Python | 3.12.14 | Tools de Office/planilhas |
| Pacotes Python | numpy 2.3.5, pandas 3.0.1, python-docx 1.2.0, python-pptx 1.0.2, openpyxl 3.1.5, Pillow 12.3.0, lxml 6.1.3, XlsxWriter 3.2.9 | Skills office |
| LibreOffice kit | `@deepseek-ai/libreoffice-kit-win32-x64` (~186 MB) | docx/pptx/xlsx → PDF, edição |
| sherpa-onnx-win-x64 | — | Speech-to-text (experimental voice input) |
| node-pty (+ conpty) | — | Terminal integrado |
| ripgrep (`@vscode/ripgrep`) | — | Busca em arquivos |
| sharp | — | Imagens |
| koffi | — | FFI (ex.: `SetConsoleCtrlHandler` no CLI Windows) |

### 2.11 CLI `dsh` (observado)

`@deepseek-ai/dsh` expõe o bin `dsh` (`lib/bin.js`) com modos:

```
dsh <name> | --profile <name>            # boota um perfil
dsh --profile <n> --from-default-profile # cria perfil a partir de template
dsh --profile acp                        # serve clientes ACP (stdio)
dsh --profile headless "job"             # roda 1 sessão e imprime resposta
dsh --profile sdk | sdk-minimal          # JSON-RPC stdio
dsh web                                  # perfil Web
dsh plugin --profile <n> <pnpm args>     # gerencia plugins do perfil
```

No Desktop, `.cmd` embarcados (`runtime/cli/bin/dsh.cmd`) rodam o mesmo CLI via `DeepSeek Harness.exe --expose-internals …/dsh-desktop-host/lib/cli.js`, com o pnpm embarcado e `manageDesktopProfile: true`. O nome de perfil `desktop` é **reservado** ao Electron.

---

## 3. Inventário quantitativo do artefato

| Métrica | Valor |
|---|---|
| `app.asar` | 121.348.951 bytes |
| Arquivos dentro do ASAR | **12.967** |
| Pacotes `@deepseek-ai/*` | **289** |
| Bundle `dsh-base` (rows de plugin) | ~100 |
| Bundle `dsh-web-app` (rows) | ~110 + 4 presets |
| Plugins de UI (`dsh-client-ui-*`) | ~55 |
| Código próprio fora de `node_modules` | 29 arquivos (`lib/`, `renderer/`, 2 JSON) |
| Binários de plataforma (asar.unpacked) | LibreOffice, sherpa-onnx, sharp, node-pty, ripgrep, koffi |
| Total `node_modules` no ASAR | ~351 MB |

---

## 4. Plano de recriação

### 4.0 Estratégia

Recriar integralmente 289 pacotes e ~500 rows de composição é um esforço de **produto maduro** (múltiplos engenheiros, vários trimestres). O plano é faseado e **cada fase entrega um app executável**, elevando fidelidade incrementalmente.

Duas trilhas:
- **Trilha A (MVP):** agente de código funcional com UI web, sessões duráveis, tools essenciais, LLM DeepSeek, empacotado como Electron.
- **Trilha B (Paridade):** superfície completa (subagentes, workflow/PTC, skills Office, STT, plugin manager, telemetria, updater, sandbox Windows ACL).

Regra de ouro extraída do alvo: **tudo é plugin**. Não construir um monólito; construir um kernel + composição declarativa.

---

### FASE 0 — Fundação do repositório (1 semana)

**Objetivo:** monorepo com build/teste/lint e o kernel de DI.

Entregáveis:
- Monorepo pnpm workspaces + TypeScript ESM, publicado em escopo próprio.
- Pacotes base: `cosmokit`-like utils, `schemastery`-like validação (ou adotar `zod`), `cordis` (kernel de DI/plugins: serviços, `ctx.inject`, `ctx.effect`, `ctx.on/emit/waterfall`, fibras, dispose).
- Loader de plugins (`cordis-plugin-loader`) capaz de ler um documento de entries e instanciar pacotes.
- Test runner + CI.

Aceite: um "hello plugin" compõe 3 plugins com injeção e dispose correto.

---

### FASE 1 — Kernel de perfis e composição (1–2 semanas)

**Objetivo:** perfis = camadas de patch YAML sobre árvore vazia.

Entregáveis:
- `profile-boot`: resolver perfil (manifest `dsh.profile.bundles` + `cordis.patch.yml` + home patch + `--patch`), com **último-por-id vence** e **config substituído, não mesclado**.
- Parser de patch YAML com suporte a expressões `!!js`.
- `app-boot`: upload do Loader, resolução de dependências de bundle, `reportSkippedBundles`, política de falha (required vs optional).
- `home-paths`: `resolveDshHome()` (`~/.dsh`, `$DSH_HOME`), `dshHomePath()`.
- `hmr`: reload do manifesto/patchs com um reload serializado.

Aceite: dois bundles compõem uma árvore; trocar `cordis.patch.yml` altera configs sem restart (com HMR).

---

### FASE 2 — Núcleo do agente (2–3 semanas)

**Objetivo:** loop de agente com LLM + tools + sessão.

Entregáveis:
- `dsh-llm`: abstração de adapter, streaming, retry, contabilização de tokens, anexos de imagem.
- `dsh-llm-deepseek`: adapter sobre `https://api.deepseek.com/anthropic` (SDK Anthropic), catálogo de modelos (`deepseek-flash`, `deepseek-v4-pro`).
- `dsh-agent` + `dsh-agent-loop`: loop turn/step, inbox (`nextTurn`/`nextStep`), status, **checkpoint antes de cada request**.
- `dsh-system-prompt` + `dsh-persona` + `dsh-agent-instructions` (personaPrefix/Suffix, working dir).
- `dsh-tools` (registro + `restrict`/schemas) e tools essenciais:
  - `dsh-tool-fs` (`read`/`write`/`edit`/`read_image`)
  - `dsh-tool-fs-search` (`glob`/`grep`)
  - `dsh-tool-bash` / `dsh-tool-pwsh` (+ variantes persistentes)
  - `dsh-tool-todo` (`todo_write`), `dsh-tool-ask-user` (`ask_user_question`)
  - `dsh-tool-web` (`web_search`/`web_fetch`), `dsh-tool-skill`
- `dsh-session` + `dsh-session-format` (catálogo v0..v4) + `dsh-session-persistence-jsonl` (frames Zstd com checksum + torn-tail recovery).
- `dsh-sandbox-local` + `dsh-sandbox-policy` + `dsh-user-approval` + `dsh-permission-presets` (modos `read-only`/`workspace-write`/`danger-full-access`).
- `dsh-timeout`, `dsh-atomic-write`, `dsh-output-retention`, `dsh-compaction*`, `dsh-token-meter`.
- `dsh-goal*`, `dsh-plan-mode`, `dsh-commands`.

Aceite: `dsh --profile headless "crie um README"` roda, usa tools, persiste `session.v4.jsonl.zstd` e imprime a resposta final.

---

### FASE 3 — Superfície Web + transporte (3–4 semanas)

**Objetivo:** UI navegador com plugins e RPC tipado.

Entregáveis:
- `dsh-host-webserver`: HTTP local com compressão, auth por token, servidor estático.
- `dsh-api-gateway` (Typert RPC): unary + streams multiplexados sobre `/api/remote.mux` (WebSocket), heartbeat, uplink, reconexão com backoff, `RemoteError`.
- `dsh-api-remotes` + controllers: `session`, `job`, `terminal`, `workspace`, `workspace-files`, `settings`, `account`.
- `dsh-client-connection`: cliente fetch/SSE do navegador + geração de reconexão.
- `dsh-client-modules`: metade Node (scaneia `dsh.client` dos plugins habilitados, monta `window.__DSH_BOOT__`, serve `/plugins/<id>/client.js` + combos + source maps) e metade browser (loader lazy-CJS, tabela `PLATFORM_MODULES` = React/Cordis/UI base).
- `dsh-web-app`: bundle web (patch) + `web-startup`/`web-runtime` (servir dist, prompt de superfície, linha de URL, abrir navegador).
- `dsh-web-frontend`: app React 18 + Vite (shell), com sistema de **slots** (`dsh-client-ui-slots`) e **dockkit**.
- `dsh-agent-preset` + `dsh-agent-preset-registry` (+ presets `standard`/`ptc`/`minimal`/`cordis`).
- UI mínima: `ui-theme`, `ui-layout`, `ui-renderer`, `ui-session`, `ui-conversation`, `ui-chat`, `ui-tool`, `ui-input-trigger`, `ui-commands`, `ui-sidebar`, `ui-settings*`.

Aceite: abrir o navegador, criar sessão, conversar, ver streaming de tools e aprovar ações.

---

### FASE 4 — Shell Desktop (2 semanas)

**Objetivo:** app Electron que embarca o runtime.

Entregáveis:
- `lib/main.js`: janela principal, welcome window, mandatory-update, update-dialog, login-loading.
- `DesktopHostProcess`: spawn do host com `ELECTRON_RUN_AS_NODE=1` + `stdio: ipc`, `--inspect` opcional, tratamento de `ready`/`fatal`/`shutdown-complete`, coleta de stderr.
- Preloads com `contextBridge` (API mínima, canais por nome em mapa, **validar sender**).
- Tray (Windows) + confirmação de "fechar para bandeja" + `background-close-confirmed`.
- Atalhos globais persistidos em `userData/keybindings.json`.
- `electron-updater` (provider `generic`, canal, `app-update.yml`) + política de update obrigatório (`dshMandatoryUpdatePolicy`, origem `https://harness.deepseek.com`).
- Branding: `icon.png`, `tray.ico`, fontes Montserrat, telas de welcome/update.

Aceite: instalável, abre, mostra a UI web embarcada, atualiza e fecha para a bandeja.

---

### FASE 5 — Runtime embarcado e Skills Office (2–3 semanas)

Entregáveis:
- Preparo de runtime portátil no primeiro uso: baixar/expandir Node + pnpm + Python + wheels, verificar `runtime.json` (digest do payload) e `versions.json`.
- `dsh-skill`, `dsh-skill-filesystem`, `dsh-skill-office`, `dsh-tool-skill`, `dsh-tool-workspace-dependencies`.
- `@deepseek-ai/libreoffice-kit` + `-win32-x64` (converter/editar docx/pptx/xlsx) + `dsh-office-to-pdf`.
- Resolução de engine Office fora do ASAR via `registerHooks` (`import.meta.resolve` → diretório `.unpacked`).
- Skills empacotadas: `office-docx`, `office-pptx`, `office-xlsx` (+ `scripts/check_office.py`).
- (Opcional B) STT via sherpa-onnx + `/speech-to-text`.

Aceite: "crie uma planilha xlsx" produz arquivo válido e "converta este docx para PDF" funciona offline.

---

### FASE 6 — Paridade avançada e operação (contínuo)

- **Delegação:** subagentes in-process (`spawn`/`fork`), `list_agents`, `send_message`, `interrupt_agent`, profundidade, `list_subagent_models`, backends externos (Codex/Claude Code como providers).
- **Workflow/PTC:** `dsh-workflow`, `-ptc`, `dsh-ptc-runtime-node` (+ Python), tool `run_code`.
- **Composição avançada:** `plugin-manager` + `dsh plugin` (instalar/habilitar/desabilitar bundles via pnpm, com lock e política de compatibilidade/`version-exemptions`), `plugin-package-inventory`.
- **MCP:** `dsh-mcp-client`, `dsh-mcp-resources`.
- **Multi-provider:** `dsh-llm-pi-ai` + página de modelos.
- **Observabilidade:** `dsh-otel`, `session-log-deepseek`, `session-telemetry-otel` (modo `FEEDBACK_ONLY`), product analytics.
- **Segurança Windows:** `dsh-sandbox-windows-acl` (restricted token; temp por sessão `<temp>\dsh-<hash>`).
- **Sessão avançada:** full-text search (sqlite `openAt`), projection cache, turn outline, stats, export (`/export`), rewind.
- **Outros:** hooks (Claude Code/Codex), webhooks (GitHub), schedule/cron, ACP/SDK servers, `dsh web`/`headless`/`sdk`/`acp`.

---

## 5. Estrutura de repositório sugerida

```
packages/
  kernel/      cordis, cosmokit, schemastery, cmdline, lazy-require, invariants, scope
  boot/        app-boot, profile-boot(?), home-paths, hmr, plugin-manager, config-editor, settings, package-manifest
  llm/         llm, llm-deepseek, llm-pi-ai, llm-retry, deepseek-llm-api-extensions
  agent/       agent, agent-loop, agent-instructions, system-prompt, persona, agent-preset(+registry)
  tools/       tools, tool-fs, tool-fs-search, tool-bash, tool-pwsh, tool-todo, tool-web, ...
  session/     session, session-format(+v0..v4), session-persistence-jsonl, session-query-sqlite, session-projection(+cache), session-title, ...
  fs/          fs, fs-local, fs-sandbox, fs-observation-policy
  sandbox/     sandbox, sandbox-local, sandbox-policy, sandbox-windows-acl, user-approval, permission-presets
  process/     subprocess(+local), jobs(+local), terminal(+bash), timeout, spill(+local,+policy)
  mcp/         mcp-client, mcp-resources
  skill/       skill, skill-filesystem, skill-office, skill-badge, office-to-pdf
  client/      client-modules, client-connection, client-locale, client-shortcuts, client-resources, client-store, client-ui-* (60+)
  host/        host-webserver, host-frontend-static, host-open-in-app, host-directory-picker*, host-plugin-inventory
  api/         api-gateway, api-remotes, api-*-controller, typert-protocol/-registry/-loader
  bundle/      base, web-app, headless, sdk-app, sdk-minimal, acp-app
apps/
  cli/         @deepseek-ai/dsh  (bin `dsh`)
  web/         dsh-web-frontend  (React+Vite)
  desktop/     dsh-desktop shell (Electron) + dsh-desktop-host
  desktop-runtime/  manifesto de runtime (dsh/package.json + desktop-runtime.json)
```

---

## 6. Decisões-chave a preservar (o que faz o produto funcionar)

1. **Composição declarativa por camadas de patch** — nada de `if` espalhado; tudo é uma row endereçável por `id`. Isso é o que permite o usuário sobrescrever qualquer comportamento sem recompilar.
2. **Último-escreve-vence por `id`; config substituída, nunca mesclada** — evita ambiguidade de merge. Toda camada que sobrescreve deve reafirmar o bloco inteiro.
3. **Ativação por disponibilidade de serviço**, não por ordem de linha.
4. **Modo "native" vs "PTC"** (tool calls nativos vs programáticos via `run_code`) — decide o formato do request ao modelo.
5. **Plano do agente movido para presets por sessão** (na web), mantendo plano do host para o que é global (registries de jobs/subagents, skill registry, token meter).
6. **Sessão append-only com migração versionada e compressão Zstd com checksum** — histórico imutável e recuperável.
7. **Typert Remote** (RPC tipado, unary + streams multiplexados com uplink) como único transporte client↔host; browser e chamadores nativos usam o mesmo WebSocket autenticado.
8. **APIs de modelo compatíveis com Anthropic** apontando para `api.deepseek.com/anthropic` — reaproveita o SDK Anthropic.
9. **Browser plugins como bundle lazy-CJS** com tabela de módulos compartilhados (React/Cordis) e HMR.
10. **Host é processo separado** do shell, comunicando por IPC — permite atualizar/reiniciar o runtime sem matar a janela e isolar crashes.

---

## 7. Riscos e complexidade

| Risco | Impacto | Mitigação |
|---|---|---|
| Cordis + Typert são o coração; recriá-los mal inviabiliza tudo | Alto | Fase 0/1 dedicadas; testes de composição antes de features |
| Volume (289 pacotes) | Alto | Trilha A primeiro; adiar Office/STT/multi-provider |
| Sandbox cross-platform (Windows ACL, restricted token) | Alto | Começar com confinamento de workspace simples; endurecer depois |
| Fidelidade do formato de sessão/v0..v4 | Médio | Pacotes de migração isolados + fixtures |
| Atualizador + política obrigatória | Médio | `electron-updater` + servidor de feed próprio |
| Telemetria/privacidade (FEEDBACK_ONLY) | Médio | Implementar gate de consentimento desde o início |
| Embedar Node/Python/pnpm (payload digest, primeiro uso) | Médio | Preparador de runtime com verificação de digest |

---

## 8. Observado × Inferido × Desconhecido

**Observado com evidência:** estrutura de camadas, boot do host, portas, perfis/bundles, composição base/web, catálogo de tools, formato de sessão, endpoint/modelos de LLM, runtime embarcado, fuses, arquivos do ASAR, perfil e dados do usuário nesta máquina.

**Inferido (com base nas evidências):** nomes/arquitetura interna do kernel Cordis; semântica exata de algumas rows; que os pacotes `dsh-*` do repositório declarado correspondem 1:1 ao empacotado; que o frontend é React 18 (das `devDependencies`).

**Desconhecido (não estabelecido):** implementação exata de cada pacote (só READMEs + JS minificado/rolldown lidos); comportamento em runtime (nenhuma execução do alvo foi realizada); conteúdo dos `client.js` do navegador além de amostras; detalhes de infraestrutura de backend (endpoints de conta/login em `harness.deepseek.com`); algoritmos internos de compactação/roteamento de modelo.

---

## 9. Encerramento

O alvo é um **harness de agente de código de nível de produto**, arquitetado como **kernel de plugins + composição declarativa**, distribuído como **Electron com runtime próprio embarcado**. A recriação realista é incremental: um kernel sólido (Fases 0–1), um agente funcional (Fase 2), uma UI web com plugins (Fase 3), e só então o shell desktop e os subsistemas de paridade (Fases 4–6).
