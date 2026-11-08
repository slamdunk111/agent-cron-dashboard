#!/usr/bin/env node
/**
 * Coverage gate for G3 (plan §5.10): `src/community/**` must have zero
 * uncovered lines in `coverage/lcov.info`. No exemption list exists, so the
 * gate cannot be talked into passing by widening one.
 *
 * Usage: node scripts/p2-coverage-gate.mjs [--lcov coverage/lcov.info]
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const argv = process.argv.slice(2)
const index = argv.indexOf('--lcov')
const lcovPath = resolve(index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : 'coverage/lcov.info')
// P3: the gate grew an explicit scope. With `--scope` (a package-relative
// suffix) only covering files are judged; the P2 invocation keeps `src/community`
// (which then also demands P2's files) and stays unchanged for that batch.
const scopeIndex = argv.indexOf('--scope')
const scopeArg = scopeIndex >= 0 && argv[scopeIndex + 1] !== undefined ? argv[scopeIndex + 1] : '/src/community/'
// `{a,b}` is a brace list of file suffixes, anything else is a plain path fragment.
const scopeMatchers =
  scopeArg.startsWith('src/') && scopeArg.includes('{')
    ? scopeArg.slice(4, -1).split(',').map((name) => `/src/community/${name}`)
    : [scopeArg]

if (!existsSync(lcovPath)) {
  console.log('COVERAGE-GATE FAIL (lcov missing)')
  process.exit(1)
}

const uncovered = []
let current = ''
for (const line of readFileSync(lcovPath, 'utf8').split('\n')) {
  if (line.startsWith('SF:')) current = line.slice(3).trim()
  if (!scopeMatchers.some((matcher) => current.includes(matcher))) continue
  const da = /^DA:(\d+),(\d+)/.exec(line)
  if (da === null) continue
  if (Number(da[2]) === 0) uncovered.push(`${current.split('/').pop()}:${da[1]}`)
}

if (uncovered.length === 0) {
  console.log('COVERAGE-GATE PASS')
  process.exit(0)
}
console.log(`COVERAGE-GATE FAIL (${uncovered.length} uncovered line(s) in ${scopeArg})`)
for (const entry of uncovered.slice(0, 40)) console.log(`  - ${entry}`)
process.exit(1)
