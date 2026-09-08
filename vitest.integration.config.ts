import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    testTimeout: 45_000,
    hookTimeout: 45_000,
    pool: 'threads',
    maxWorkers: 1,
    fileParallelism: false,
  },
})
