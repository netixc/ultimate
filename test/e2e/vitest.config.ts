import { defineConfig } from 'vitest/config'
import { artifactE2eTests } from '../../.ultimate/extensions/artifacts/test/config.ts'

export default defineConfig({
  test: {
    reporters: ['default'],
    globalSetup: ['test/sweep-temp.ts'],
    setupFiles: ['test/setup.ts'],
    include: ['test/e2e/**/*.test.ts', artifactE2eTests],
    testTimeout: 60_000,
    maxWorkers: 4,
  },
})
