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
// P7 fix: the brace list used to be expanded under a hardcoded `/src/community/`
// prefix, so any other `src/.../{a,b}.ts` scope matched no file and the gate
// passed vacuously. The directory now comes from the scope itself, the `.ts`
// tail after the closing brace is re-applied to every member, and a matcher
// that still holds `{`/`}` aborts the gate instead of passing.
const scopeMatchers =
  scopeArg.includes('{') && scopeArg.includes('}')
    ? (() => {
        const slash = scopeArg.lastIndexOf('/')
        const dir = scopeArg.slice(0, slash + 1)
        // The brace list omits the shared extension: `{a,b}.ts` names `a` and `b.ts`.
        const tail = scopeArg.slice(slash + 1)
        const ext = tail.slice(tail.lastIndexOf('}') + 1)
        const names = tail.slice(1, tail.lastIndexOf('}')).split(',').filter(Boolean)
        return names.map((name) => `${dir}${name}${name.includes('.') ? '' : ext}`)
      })()
    : [scopeArg]
if (scopeMatchers.some((matcher) => matcher.includes('{') || matcher.includes('}'))) {
  console.log(`COVERAGE-GATE FAIL (scope not expandable: ${scopeArg})`)
  process.exit(1)
}

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
