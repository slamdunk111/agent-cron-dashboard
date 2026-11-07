/**
 * Workspace Vitest configuration (`pnpm -r test`).
 *
 * P0 scope: `pnpm -r test` must be green even before feature plans add their
 * suites, so every spec the gate depends on (contracts, the config-schema
 * negative corpus that the smoke script replays) lives under `test/`.
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    reporters: ['default'],
  },
})
