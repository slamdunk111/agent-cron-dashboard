#!/usr/bin/env node
/**
 * P6 evidence summary: every number the report quotes is produced here from the
 * fixed gate logs, the fixtures and the plan (十六次号令闸门 1「数字机器生成」).
 *
 * Usage:
 *   node scripts/p6-evidence-summary.mjs [--out ../docs/handoff/p6-evidence.json]
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const argv = process.argv.slice(2)
const outIndex = argv.indexOf('--out')
const outPath = resolve(outIndex >= 0 && argv[outIndex + 1] !== undefined ? argv[outIndex + 1] : resolve(ROOT, '../docs/handoff/p6-evidence.json'))

const readOrEmpty = (path) => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}
const sha256 = (path) => {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return ''
  }
}
const mtimeText = (path) => {
  try {
    const d = new Date(statSync(path).mtimeMs + 8 * 3_600_000)
    return d.toISOString().replace('Z', '+08:00')
  } catch {
    return ''
  }
}

const g1Path = resolve(ROOT, '../docs/handoff/p6-g1.log')
const g3Path = resolve(ROOT, '../docs/handoff/p6-g3.log')
const baselinePath = resolve(ROOT, '../docs/handoff/p6-baseline.txt')
const setPath = resolve(ROOT, 'fixtures/fleet/p6-fingerprint-set.json')
const planPath = resolve(ROOT, '.omo/plans/p6-error-closure.md')
const mirrorPath = resolve(ROOT, '../docs/handoff/P6-实施计划.md')
const g1 = readOrEmpty(g1Path)
const g3 = readOrEmpty(g3Path)
const baseline = readOrEmpty(baselinePath)
const set = JSON.parse(readOrEmpty(setPath) || '{"cases":[],"sameCauseGroups":[]}')

/** One labelled capture of a grep-shaped number. */
const firstOf = (text, re) => (re.exec(text) ?? [])[0] ?? null
const allOf = (text, re) => [...text.matchAll(re)].map((match) => match.slice(1))

const evalLine = firstOf(g1, /^fp eval .*$/m)
const sealLine = firstOf(g1, /^replay_seal .*$/m)
const liveLine = firstOf(g1, /^live analysis .*$/m)
const openedLine = firstOf(g1, /^live keys .*$/m)
const sourceLine = firstOf(g1, /^live source=.*$/m)
const keysLine = firstOf(g1, /^script keys .*$/m)
const bridgeLine = firstOf(g1, /^script bridge .*$/m)
const maskLine = firstOf(g1, /^script mask .*$/m)
// `matchAll` on a global regex returns full matches; capture the line text itself.
const greenLines = [...g1.matchAll(/^script green .*$/gm)].map((match) => match[0])
const envLine = firstOf(g1, /^env TZ_OFFSET=.*$/m)
const g1Verdict = firstOf(g1, /^GATE G1 .*$/m)
const g3Verdict = firstOf(g3, /^GATE G3 .*$/m)
const testsLine = firstOf(g3, /^\s*Tests\s+\d+ passed \(\d+\)$/m)
const covLine = firstOf(g3, /^COVERAGE-GATE .*$/m)
const baseLine = firstOf(baseline, /^BASELINE .*$/m)
const g3Markers = {
  mirror: firstOf(g3, /^MIRROR PASS.*$/m),
  typecheck: firstOf(g3, /^TYPECHECK (PASS|FAIL)$/m),
  sync: firstOf(g3, /^SYNC-CONTRACTS (PASS|FAIL)$/m),
  p5zero: firstOf(g3, /^P5-ZERO-REF (PASS|FAIL)$/m),
  matrix: firstOf(g3, /^STATE-MATRIX (PASS|FAIL)$/m),
}

const numberIn = (line, key) => Number((new RegExp(`${key}=(\\d+)`).exec(line ?? '') ?? [])[1] ?? NaN)

/** How many same-cause groups and different-cause cases the sheet carries. */
const sheet = {
  cases: set.cases.length,
  same: set.cases.filter((entry) => entry.expect === 'same').length,
  diff: set.cases.filter((entry) => entry.expect === 'diff').length,
  groups: set.sameCauseGroups.length,
  derivedFrom: [...new Set(set.cases.map((entry) => entry.derived_from.file))],
}

/** Distinct sources of the live window (the lines that named a host). */
const evidence = {
  generated_at: new Date().toISOString(),
  gate_logs: {
    g1: { path: 'docs/handoff/p6-g1.log', sha256: sha256(g1Path), mtime: mtimeText(g1Path), verdict: g1Verdict, exit: firstOf(g1, /^EXIT rc=\d+$/m) },
    g3: { path: 'docs/handoff/p6-g3.log', sha256: sha256(g3Path), mtime: mtimeText(g3Path), verdict: g3Verdict, exit: firstOf(g3, /^EXIT rc=\d+$/m) },
  },
  fingerprint: { eval: evalLine, seal: sealLine, sheet, sheetSha256: sha256(setPath), recordedCasesSha256: set.casesSha256 ?? null },
  playbooks: { keys: keysLine, bridge: bridgeLine, mask: maskLine, green: greenLines, opened: numberIn(keysLine, 'error-record-opened'), reopened: numberIn(keysLine, 'error-record-reopened'), verified: numberIn(keysLine, 'error-record-verified') },
  live: { source: sourceLine, opened: openedLine, analysis: liveLine, model: (liveLine ?? '').includes('model=') ? (liveLine ?? '').split('model=')[1]?.split(' ')[0] ?? null : null },
  tests: { line: testsLine, passed: Number((/Tests\s+(\d+) passed/.exec(testsLine ?? '') ?? [])[1] ?? 0), baseline: baseLine, coverage: covLine, markers: g3Markers },
  plan: { path: '.omo/plans/p6-error-closure.md', sha256: sha256(planPath), mirror: { path: 'docs/handoff/P6-实施计划.md', sha256: sha256(mirrorPath), exists: existsSync(mirrorPath) } },
  environment: envLine,
}

writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`)
console.log(`evidence written ${outPath}`)
console.log(`g1 ${g1Verdict ?? '(missing)'}`)
console.log(`g3 ${g3Verdict ?? '(missing)'}`)
console.log(`${testsLine ?? '(no tests line)'} coverage=${covLine ?? '(missing)'}`)
console.log(`${evalLine ?? '(no fp eval)'}`)
console.log(`${liveLine ?? '(no live line)'}`)
