#!/usr/bin/env node
/**
 * Copies the frozen contracts into the packages that need them at runtime.
 *
 * dsh copies a linked package directory into the profile's node_modules, so a
 * relative import above the package (`../../../contracts/...`) cannot resolve
 * after installation. The main bundle therefore carries a generated copy of
 * `contracts/config-validate.ts`; this script is the single way it is updated.
 *
 * Usage: node scripts/sync-contracts.mjs [--check]
 *   --check  exits 1 when a generated copy is stale (used by the smoke gate)
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const COPIES = [
  {
    from: 'contracts/config-validate.ts',
    to: 'packages/agent-cron-dashboard/src/config-validate.ts',
    banner: `/**
 * Runtime validation of the frozen workbench config schema.
 *
 * GENERATED COPY: the source of truth is \`contracts/config-validate.ts\` in the
 * release repository; \`pnpm sync:contracts\` copies it into the package so the
 * published bundle is self-contained (dsh copies the linked package into the
 * profile node_modules, so relative hops above the package cannot resolve).
 */
`,
  },
]

let stale = 0
for (const copy of COPIES) {
  const source = readFileSync(resolve(root, copy.from), 'utf8')
  // Drop the source's own header comment; the banner replaces it.
  const body = source.replace(/^\/\*\*[\s\S]*?\*\/\s*/, '')
  const expected = `${copy.banner}${body}`
  const target = resolve(root, copy.to)
  const current = readFileSync(target, 'utf8')
  if (current === expected) {
    console.log(`ok   ${copy.to}`)
    continue
  }
  stale += 1
  if (process.argv.includes('--check')) {
    console.log(`STALE ${copy.to} (run: pnpm sync:contracts)`)
  } else {
    writeFileSync(target, expected)
    console.log(`wrote ${copy.to}`)
  }
}
process.exit(stale === 0 ? 0 : 1)
