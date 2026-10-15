# Open Harness (dsh) — Recriação

Recriação do **DeepSeek Harness** a partir do documento de análise
`DeepSeek Harness - Plano de Recriacao.md`. Monorepo funcional que segue o
sistema do dsh: **kernel de plugins (cordis) + composição declarativa de
perfis por camadas de patch YAML**.

> **Escopo desta entrega: Fase 0 + Fase 1** do plano (fundação + kernel de
> perfis e composição). As fases seguintes (núcleo do agente, superfície web,
> shell desktop, runtime embarcado, paridade avançada) estão no roadmap.

## Estado

| Fase | Estado |
| ---- | ------ |
| 0 — Fundação (monorepo, kernel DI, loader, testes/CI) | ✅ concluída |
| 1 — Perfis e composição (bundles, patch YAML, HMR) | ✅ concluída |
| 2 — Núcleo do agente (LLM, tools, loop, sessão) | ⏳ planeada |
| 3 — Superfície Web + transporte | ⏳ planeada |
| 4 — Shell Desktop (Electron) | ⏳ planeada |
| 5 — Runtime embarcado + Skills Office | ⏳ planeada |
| 6 — Paridade avançada e operação | ⏳ planeada |

## Arranque rápido

```bash
pnpm install       # liga os pacotes do workspace
pnpm check         # typecheck (build + testes) e 100 testes
pnpm test          # só os testes
pnpm build         # tsc -b de todos os pacotes (composite)
```

Requer Node ≥ 24 e pnpm 12.

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

## Decisões conscientes (divergências do plano)

- **Home de dados**: `OPEN_HARNESS_HOME` / `OHSH_HOME` → default
  `~/.open-harness`. **Não lê `DSH_HOME`** de propósito, para não colidir com
  um DeepSeek Harness real instalado na mesma máquina.
- **Escopo npm**: `@open-harness/*`, mantendo os nomes de pacotes do sistema
  original (`cosmokit`, `schemastery`, `cordis`, `cordis-plugin-loader`,
  `home-paths`, `profile-boot`, `app-boot`, `hmr`), com implementação própria.
- Stack: TypeScript 7 (nativo), Vitest 5, pnpm workspaces, ESM estrito.

## Roadmap (Fases 2–6, resumo do plano)

- **Fase 2 — Núcleo do agente**: `dsh-llm` (abstração + adapter DeepSeek),
  `dsh-agent`/`dsh-agent-loop` (turn/step, checkpoint antes de cada request),
  `dsh-system-prompt`/`dsh-persona`, `dsh-tools` (fs, exec, …), sessão.
- **Fase 3 — Superfície Web + transporte**: UI web do harness, transporte
  (IPC/streaming) entre host e renderer.
- **Fase 4 — Shell Desktop**: Electron com fuses endurecidos, preload mínimo.
- **Fase 5 — Runtime embarcado + Skills Office**: runtime incorporado e skills
  de documentos Office.
- **Fase 6 — Paridade avançada e operação**: telemetria, actualização,
  hardening e paridade restante com o dsh observado.

## Testes

`pnpm check` corre typecheck de build, typecheck dos testes e a suite inteira
(100 testes): kernel (cordis, loader), composição (profile-boot), arranque
(app-boot), HMR (unit + integração com app-boot — o critério de aceite da
Fase 1) e home-paths.
