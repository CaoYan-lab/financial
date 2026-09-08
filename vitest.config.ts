import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/**/*.integration.test.ts', 'tests/**/*.smoke.test.ts', 'tests/e2e/**'],
    pool: 'threads',
    maxWorkers: 4,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      include: ['api/cloud/multiuser/**/*.ts'],
      exclude: ['api/cloud/multiuser/types.ts'],
      thresholds: {
        lines: 85,
        branches: 80,
      },
    },
  },
})
