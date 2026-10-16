# Open Harness (dsh)

[![CI](https://github.com/Luizvt-dev/open-harness/actions/workflows/ci.yml/badge.svg)](https://github.com/Luizvt-dev/open-harness/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Recriação do **DeepSeek Harness** a partir do documento de análise
`DeepSeek Harness - Plano de Recriacao.md`. Monorepo funcional que segue o
sistema do dsh: **kernel de plugins (cordis) + composição declarativa de
perfis por camadas de patch YAML**, com implementação própria, escopo npm
`@open-harness/*` e comentários/README em português.

> **Escopo desta entrega (v0.1.0):** Fases 0, 1 e 2 do plano (fundação,
> kernel de perfis/composição e núcleo do agente com a CLI `dsh`), o
> **sistema de provedores múltiplos** (registry + catálogo + adapters por
> protocolo) e a **Fase 3**: servidor web local, gateway RPC, cliente de
> ligação e a **UI web inicial** — sessões, conversa em stream com tools e
> histórico persistido. Os plugins de UI do browser seguem no roadmap.

## Estado

| Fase | Estado |
| ---- | ------ |
| 0 — Fundação (monorepo, kernel DI, loader, testes/CI) | ✅ concluída |
| 1 — Perfis e composição (bundles, patch YAML, HMR) | ✅ concluída |
| 2 — Núcleo do agente (LLM, tools, loop, sessão, CLI) | ✅ concluída |
| 2+ — Provedores múltiplos (registry, catálogo, adapters) | ✅ concluída |
| 3 — Superfície Web + transporte | 🟡 UI inicial entregue (sem plugins de UI) |
| 4 — Shell Desktop (Electron) | ⏳ planeada |
| 5 — Runtime embarcado + Skills Office | ⏳ planeada |
| 6 — Paridade avançada e operação | ⏳ planeada |

## Requisitos

- **Node ≥ 24** (usa `node:zlib` nativo para Zstd e CRC32)
- **pnpm 12** (workspaces)
- TypeScript 7 (nativo) e Vitest 5 — instalados pelo próprio `pnpm install`

## Instalação

```bash
git clone https://github.com/Luizvt-dev/open-harness.git
cd open-harness

pnpm install      # liga os pacotes do workspace
pnpm check        # typecheck (build + testes) + suite completa
pnpm build        # tsc -b de todos os pacotes (composite)
```

`pnpm check` é a porta de entrada da CI: `tsc -b` → `tsc -p tsconfig.test.json`
→ `vitest run`. Neste momento corre **347 testes em 29 ficheiros**.

## Uso

### CLI `dsh`

```bash
pnpm dsh --profile headless "crie um README"   # turno real (precisa de API key)
pnpm dsh --offline -v "crie um README"         # sem rede: tools + sessão
pnpm dsh models                               # provedores e modelos do perfil
pnpm dsh --model openai/gpt-5.4 "olá"          # escolher provedor por referência
```

As chaves vão no ambiente (`DEEPSEEK_API_KEY`, `OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, …). O home de dados é
`OPEN_HARNESS_HOME` (ou `OHSH_HOME`), por omissão `~/.open-harness`.

### Servidor web `dsh web`

```bash
pnpm dsh web                       # sobe a interface em http://127.0.0.1:3080
pnpm dsh web --port 0              # porta livre (efémera)
pnpm dsh web --offline --port 0    # sem rede, para testar sem API key
```

A CLI imprime quatro linhas: a URL base (`dsh web em …`), a **linha
`browser`** com o token na query — é essa que se clica para abrir a UI já
autenticada —, o `token` separado (para clientes programáticos) e o perfil
arrancado.

A interface (HTML/CSS/JS sem bundler, em `apps/dsh/bundles/web/public/`)
liga-se ao host pelo mesmo WebSocket do protocolo: barra lateral de sessões,
conversa com o texto a chegar em *stream*, linhas de tool com input/output e
cancelamento do turno. Na primeira carga o token vai para o `sessionStorage`
e para um cookie (`SameSite=Strict`), porque os módulos ES e o CSS não
conseguem mandar headers próprios; a URL fica limpa na barra de endereço.

O comando sobe o perfil `web` (bundle `apps/dsh/bundles/web`): servidor HTTP
local com **auth por token obrigatório**, estático com SPA fallback, e um
gateway RPC único servido por três caminhos — `POST /api/remote` (unary),
`POST /api/remote/stream` (SSE) e WebSocket `/api/remote.mux` (RPC
multiplexado com heartbeat). O token e o URL são anunciados no arranque.

### Cliente de ligação

```ts
import { createClient } from '@open-harness/dsh-client-connection'

const client = createClient({ url: 'http://127.0.0.1:3080', token })
await client.whenOpen()

const session = await client.call('session.create', {})
for await (const event of client.stream('job.run', { sessionId: session.id, text: 'olá' })) {
  console.log(event)
}
```

O cliente usa os globals `WebSocket`/`fetch` (zero dependências), reconecta
com backoff exponencial + jitter e encaminha o caminho HTTP/SSE quando o
WebSocket falha.

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
                          # TokenMeter, LlmClient, SseParser e AnthropicAdapter
    dsh-llm-deepseek/     # DeepSeekAdapter (preset do protocolo Anthropic)
    dsh-provider/         # registry de provedores, catálogo, refs provedor/modelo
                          # e adapters OpenAI (chat) e Google (Gemini)
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
  web/
    dsh-host-webserver/   # servidor local: estático+SPA, compressão, auth e upgrade WS
    dsh-api-gateway/      # Gateway RPC, MuxConnection, createHttpRpc, RemoteError
    dsh-api-remotes/      # controllers: session, job, workspace, settings, stubs
    dsh-client-connection/# cliente do browser: MuxClient, HttpClient, createClient
    dsh-client-modules/   # boot do manifesto, /plugins e loader lazy no browser
    dsh-client-ui-slots/   # registo de slots (framework-agnóstico) + bindings React
apps/
  dsh/                    # CLI `dsh`: perfis, overlay de runtime, modo offline
    bundles/headless/     # perfil sem UI (agente + tools)
    bundles/web/          # perfil com servidor web (agente + tools + webserver)
      public/             # a UI servida: index.html (shell React) e style.css
  web/
    dsh-web-frontend/     # shell React: sessões, conversa, composer e slots
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

As expressões `!!js` do patch YAML são avaliadas **no boot** (não em
compilação) no escopo global — os ficheiros de patch são configuração local
de confiança.

### HMR (critério de aceite da Fase 1)

`Hmr` serializa reloads (nunca em paralelo) e agrega os triggers que chegam
durante um reload activo. `PluginLoader.update()` faz o diff por assinatura +
fingerprint de config: só a config mudou e há `reconfigure` → **actualização
quente**; caso contrário reinício da linha; linhas removidas → dispose.
Ou seja: **escrever no `cordis.patch.yml` altera configs sem reiniciar o
processo**.

### Núcleo do agente (Fase 2)

- **LLM** — contrato Anthropic-like com erros tipados, retry/backoff,
  `TokenMeter`, `SseParser` e `AnthropicAdapter`; `DeepSeekAdapter` é o
  preset DeepSeek (endpoint `https://api.deepseek.com/anthropic`).
  **Não** usamos SDKs oficiais de provedor.
- **Provedores múltiplos** — referências `provedor/modelo`, catálogo embutido
  determinístico (`deepseek`, `anthropic`, `openai`, `google`, `openrouter`,
  `groq`, `ollama`), protocolos `anthropic-messages`, `openai-chat`,
  `openai-compatible` e `google-generate`, chaves por literal/`env`/`file`
  com erro exacto a indicar a variável em falta.
- **Sessão** — formato **v4 canónico** com migrações v0–v3, persistência em
  frames `<crc32>$<base64>` sobre Zstd, caminho
  `<home>/sessions/<workspace>/<id>/session.v4.jsonl.zstd`.
- **Loop e tools** — checkpoint e persistência **antes de cada request**;
  erro de tool vira `isError` sem abortar o turno; `maxStepsPerTurn` sinaliza
  `stoppedByLimit`.

### Transporte web (Fase 3)

- **Protocolo "Typert Remote" v1** — JSON sobre WebSocket; o `id` multiplexa
  chamadas *unary* e *streams* na mesma ligação; heartbeat ping/pong fecha no
  4000; versão errada fecha no 4001; o único erro no fio é `RemoteError`.
- **Caminhos paralelos** — o mesmo gateway serve HTTP (`/api/remote`) e SSE
  (`/api/remote/stream`, eventos `open|data|end|error`) com os mesmos
  códigos de erro do WebSocket.
- **Auth** — token obrigatório em todas as rotas, por `Authorization:
  Bearer`, `?access_token=` (necessário no handshake WS) ou cookie
  `access_token` (o único que um `<script type="module">` ou um CSS consegue
  levar), comparado com `timingSafeEqual`.
- **Sessões** — cada sessão web é um agente irmão: mesmo modelo, system
  prompt, adapter e tools do perfil, mas histórico e ficheiro próprios.

### Interface web (Fase 3)

- **Sem bundler** — o `index.html` injecta um *import map* construído a partir
  da tabela `platform` do manifesto de boot: uma só fonte, servida pelo host,
  que resolve os shims do React, o shell e os `dist` dos pacotes do workspace
  em `/client/<pacote>/`.
- **Shell React** — `apps/web/dsh-web-frontend` é a UI (sessões, conversa,
  composer) montada em `#root`. Os UMD do React 18 entram por tags clássicas
  (`window.React`/`window.ReactDOM`) e quatro shims ESM de `platform/`
  expõem-nos como módulos; em `/platform/` só o que `platformFiles()` declara
  é servível.
- **Slots** — o shell desenha `sidebar.*`, `topbar.*`, `messages.after`,
  `composer.*` e `chat.item.*`; os pacotes `ui-*` inscrevem-se por eles sem
  o shell os conhecer.
- **Entrada browser do gateway** — `dsh-api-gateway/browser` re-exporta só o
  protocolo e `RemoteError`; a entrada `.` puxa `node:crypto` e não corre no
  navegador (há asserção disto na suíte).
- **`session.history`** — o host projeta os registos persistidos da sessão
  para o ecrã (`user`/`assistant`/`tool`, com `tool_use` + `tool_result` já
  fundidos), para o refresh não perder a conversa.

## Testes

`pnpm check` corre typecheck de build, typecheck dos testes e a suite inteira
(**412 testes / 33 ficheiros**): kernel (cordis, loader), composição
(profile-boot), arranque (app-boot), HMR, home-paths, LLM, provedores, sessão
(formato, `Session`, persistência zstd), tools, loop, serviço `agent`, a
**CLI `dsh`** (incluindo o teste de aceite da Fase 2 que corre
`dsh --profile headless "crie um README"` de ponta a ponta) e a **aceitação
da Fase 3** — `dsh web` a subir um servidor real, um cliente Node a falar com
ele por WebSocket e HTTP/SSE, a UI e os módulos do cliente a serem servidos
pelo cookie, o histórico de conversa a voltar do disco, e o shell React
(reducer, SSR, slots, `/shell` e `/platform/`), tudo sem navegador.

## Roadmap (Fases 3–6)

- **Fase 3 — Superfície Web**: transporte, módulos do cliente, slots e **shell
  React entregues**; falta a leva de plugins `ui-*` do plano por cima desta
  base.
- **Fase 4 — Shell Desktop**: Electron com fuses endurecidos, preload mínimo.
- **Fase 5 — Runtime embarcado + Skills Office**: runtime incorporado e skills
  de documentos Office.
- **Fase 6 — Paridade avançada e operação**: telemetria, actualização,
  hardening e paridade restante com o dsh observado.
- Continua por criar: `dsh-system-prompt`/`dsh-persona` (hoje o system prompt
  vive no bundle) e mais tools do catálogo.

## Como contribuir

1. **Fork e branch** — crie uma branch a partir de `main`
   (`git checkout -b feat/minha-melhoria`).
2. **Antes de commitar** — `pnpm check` tem de ficar verde (typecheck de
   build, typecheck dos testes e suite completa). Um PR sem checks verdes não
   é revisto.
3. **Estilo** — ESM estrito, TypeScript 7 nativo, sem dependências novas sem
   justificação; comentários e documentação em português, seguindo o padrão
   dos pacotes existentes (explicar o *porquê*, não o *qué*).
4. **Testes** — toda a mudança de comportamento leva teste; os testes de
   aceite vivem em `*/test/*.test.ts` e correm no CI.
5. **Commits** — mensagens no formato Conventional Commits
   (`feat:`, `fix:`, `docs:`, `testes:`, `refactor:`).
6. **PR** — descreva o problema, a abordagem e como testou; mantenha o diff
   focado num tema.

### Estrutura dos pacotes

Cada pacote é um workspace com `package.json` (`@open-harness/…`), `src/`,
`test/` e `tsconfig.json` *composite*. Os alias `@open-harness/*` estão em
sincronia em três sítios — `vitest.config.ts`, `tsconfig.test.json` e as
`references` do `tsconfig.json` — e novos pacotes têm de ser registados nos
três.

## Licença e Direitos Autorais

Este projecto é licenciado sob a **Apache License, Version 2.0** — texto
integral no ficheiro [LICENSE](LICENSE).

- **Copyright 2026 Luiz Fernando De Souza Neves (@Luizvt-dev).**
- Os créditos de autoria original estão no ficheiro [NOTICE](NOTICE), exigido
  pela **Secção 4d** da Apache 2.0.
- **Qualquer redistribuição ou versão modificada deste projecto deve manter o
  aviso de atribuição do ficheiro `NOTICE` intacto e legível**, conforme a
  mesma Secção 4d. Remover ou alterar esses créditos viola os termos da
  licença.
- Ao contribuir, você aceita que as suas contribuições sejam licenciadas sob
  a Apache License 2.0, nos termos da **Secção 5** (Submission of
  Contributions).

O ficheiro `NOTICE` deve ser incluído em qualquer distribuição binária ou
derivada, junto do `LICENSE`.
