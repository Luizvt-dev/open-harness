import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const local = (p: string) => fileURLToPath(new URL(p, import.meta.url))

// Mesmo mapa do `paths` em tsconfig.test.json — mantenha os dois em sincronia.
const aliases: Record<string, string> = {
  '@open-harness/cordis-plugin-loader': local('packages/kernel/cordis-plugin-loader/src/index.ts'),
  '@open-harness/cordis': local('packages/kernel/cordis/src/index.ts'),
  '@open-harness/cosmokit': local('packages/kernel/cosmokit/src/index.ts'),
  '@open-harness/schemastery': local('packages/kernel/schemastery/src/index.ts'),
  '@open-harness/home-paths': local('packages/boot/home-paths/src/index.ts'),
  '@open-harness/profile-boot': local('packages/boot/profile-boot/src/index.ts'),
  '@open-harness/app-boot': local('packages/boot/app-boot/src/index.ts'),
  '@open-harness/hmr': local('packages/boot/hmr/src/index.ts'),
  '@open-harness/dsh-llm': local('packages/llm/dsh-llm/src/index.ts'),
  '@open-harness/dsh-llm-deepseek': local('packages/llm/dsh-llm-deepseek/src/index.ts'),
  '@open-harness/dsh-session-format': local('packages/session/dsh-session-format/src/index.ts'),
  '@open-harness/dsh-session': local('packages/session/dsh-session/src/index.ts'),
  '@open-harness/dsh-session-persistence-jsonl': local(
    'packages/session/dsh-session-persistence-jsonl/src/index.ts',
  ),
  '@open-harness/dsh-tools': local('packages/agent/dsh-tools/src/index.ts'),
  '@open-harness/dsh-tool-fs': local('packages/agent/dsh-tool-fs/src/index.ts'),
  '@open-harness/dsh-tool-fs-search': local('packages/agent/dsh-tool-fs-search/src/index.ts'),
  '@open-harness/dsh-tool-bash': local('packages/agent/dsh-tool-bash/src/index.ts'),
  '@open-harness/dsh-agent-loop': local('packages/agent/dsh-agent-loop/src/index.ts'),
  '@open-harness/dsh-agent': local('packages/agent/dsh-agent/src/index.ts'),
  '@open-harness/dsh-cli': local('apps/dsh/src/index.ts'),
}

export default defineConfig({
  resolve: {
    alias: Object.entries(aliases).map(([find, replacement]) => ({ find, replacement })),
  },
  test: {
    include: ['packages/**/test/**/*.test.ts', 'apps/**/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20000,
    hookTimeout: 20000,
  },
})
