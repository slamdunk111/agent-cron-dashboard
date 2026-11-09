#!/usr/bin/env node
/**
 * Coverage gate for G3: the files named by `--scope` must have zero uncovered
 * lines in `coverage/lcov.info`.
 *
 * Usage: node scripts/p2-coverage-gate.mjs [--lcov coverage/lcov.info] [--scope src/a.ts]...
 *   --scope   a path fragment, a file, or a brace list (`src/x/{a,b}.ts`)
 *   A scope that matches no file in the lcov FAILS (it must never pass on an
 *   empty set); a source line carrying `coverage-gate-ignore` is exempt and is
 *   read from the file itself, so the exemption is visible in review.
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Lines that carry this marker in the source are not judged (legacy statements
// that predate the gate, or a deliberate exemption named in the plan). The
// marker is read from the file itself, so it can never be invisible.
const EXEMPTION_MARKER = 'coverage-gate-ignore'
const sourceCache = new Map()
function exemptLines(sourcePath) {
  if (!sourceCache.has(sourcePath)) {
    const found = new Set()
    if (existsSync(sourcePath)) {
      for (const line of readFileSync(sourcePath, 'utf8').split('\n')) {
        if (line.includes(EXEMPTION_MARKER)) {
          const n = Number(line.slice(0, line.indexOf(EXEMPTION_MARKER)).replace(/[^0-9]/g, ''))
          if (Number.isInteger(n) && n > 0) found.add(n)
        }
      }
    }
    sourceCache.set(sourcePath, found)
  }
  return sourceCache.get(sourcePath)
}

const argv = process.argv.slice(2)
const index = argv.indexOf('--lcov')
const lcovPath = resolve(index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : 'coverage/lcov.info')
// P3: the gate grew an explicit scope. With `--scope` (a package-relative
// suffix) only covering files are judged; the P2 invocation keeps `src/community`
// (which then also demands P2's files) and stays unchanged for that batch.
const scopeArgs = []
for (let i = 0; i < argv.length; i += 1) if (argv[i] === '--scope' && argv[i + 1] !== undefined) scopeArgs.push(argv[i + 1])
if (scopeArgs.length === 0) scopeArgs.push('/src/community/')
const scopeArg = scopeArgs.join(' ')
const scopeMatchers = scopeArgs.flatMap((one) =>
  one.includes('{') && one.includes('}')
    ? (() => {
        const slash = one.lastIndexOf('/')
        const dir = one.slice(0, slash + 1)
        const tail = one.slice(slash + 1)
        const ext = tail.slice(tail.lastIndexOf('}') + 1)
        return tail.slice(1, tail.lastIndexOf('}')).split(',').filter(Boolean).map((name) => `${dir}${name}${name.includes('.') ? '' : ext}`)
      })()
    : [one])
if (scopeMatchers.some((matcher) => matcher.includes('{') || matcher.includes('}'))) {
  console.log(`COVERAGE-GATE FAIL (scope not expandable: ${scopeArg})`)
  process.exit(1)
}

if (!existsSync(lcovPath)) {
  console.log('COVERAGE-GATE FAIL (lcov missing)')
  process.exit(1)
}

const uncovered = []
// P7 fix: a scope that matches no file in the lcov must fail, not pass on an
// empty set (the R8 finding: `src/ui/{…}` matched nothing and passed).
let matchedFiles = 0
const seenFiles = new Set()
let current = ''
for (const line of readFileSync(lcovPath, 'utf8').split('\n')) {
  if (line.startsWith('SF:')) current = line.slice(3).trim()
  const hit = scopeMatchers.some((matcher) => current.includes(matcher))
  if (hit && !seenFiles.has(current)) {
    seenFiles.add(current)
    matchedFiles += 1
  }
  if (!hit) continue
  const da = /^DA:(\d+),(\d+)/.exec(line)
  if (da === null) continue
  const lineNo = Number(da[1])
  if (exemptLines(current).has(lineNo)) continue
  if (Number(da[2]) === 0) uncovered.push(`${current.split('/').pop()}:${da[1]}`)
}

if (matchedFiles === 0) {
  console.log(`COVERAGE-GATE FAIL (scope matched no file: ${scopeArg})`)
  process.exit(1)
}
if (uncovered.length === 0) {
  console.log(`COVERAGE-GATE PASS files=${matchedFiles}`)
  process.exit(0)
}
console.log(`COVERAGE-GATE FAIL (${uncovered.length} uncovered line(s) in ${scopeArg})`)
for (const entry of uncovered.slice(0, 40)) console.log(`  - ${entry}`)
process.exit(1)
