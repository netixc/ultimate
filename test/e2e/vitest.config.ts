import { defineConfig } from 'vitest/config'
import { artifactE2eTests } from '../../.ultimate/extensions/artifacts/test/config.ts'
import { fleetE2eTests } from '../../.ultimate/extensions/fleet/test/config.ts'

export default defineConfig({
  test: {
    reporters: ['default'],
    globalSetup: ['test/sweep-temp.ts'],
    setupFiles: ['test/setup.ts'],
    include: ['test/e2e/**/*.test.ts', artifactE2eTests, fleetE2eTests],
    testTimeout: 60_000,
    maxWorkers: 4,
  },
})
