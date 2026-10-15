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
}

export default defineConfig({
  resolve: {
    alias: Object.entries(aliases).map(([find, replacement]) => ({ find, replacement })),
  },
  test: {
    include: ['packages/**/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20000,
    hookTimeout: 20000,
  },
})
