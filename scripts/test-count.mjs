#!/usr/bin/env node
/**
 * Machine source for the test counts quoted in reports.
 *
 * Reports must not hand-copy numbers ("145/147/148" drifted four times across
 * external reviews). This script prints the per-file and total counts from
 * vitest's own reporter, and `smoke-p0.sh` writes its output next to the smoke
 * log so a report can cite one machine line.
 *
 * Usage: node scripts/test-count.mjs [--json]
 */
import { spawnSync } from 'node:child_process'

const args = ['exec', 'vitest', 'run', '--reporter=json', '--outputFile=/tmp/vitest-count.json']
const run = spawnSync('corepack', ['pnpm', ...args], { encoding: 'utf8' })
if (run.status !== 0) {
  console.error(run.stdout?.slice(-400) ?? '', run.stderr?.slice(-400) ?? '')
  process.exit(run.status ?? 1)
}
const { readFileSync } = await import('node:fs')
const report = JSON.parse(readFileSync('/tmp/vitest-count.json', 'utf8'))
const files = report.testResults.map((file) => ({
  file: file.name.split('/').slice(-1)[0],
  tests: file.assertionResults.length,
}))
const total = files.reduce((sum, entry) => sum + entry.tests, 0)
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ total, files }, null, 2))
} else {
  for (const entry of files.sort((a, b) => b.tests - a.tests)) console.log(`${entry.tests}\t${entry.file}`)
  console.log(`TOTAL\t${total}`)
}
