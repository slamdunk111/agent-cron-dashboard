#!/usr/bin/env node
/**
 * P6 fingerprint evaluation over the measured-samples sheet (plan §2.1/§6).
 *
 * Reads `fixtures/fleet/p6-fingerprint-set.json` (every case derived from a P5
 * measured row, carrying `derived_from`), prints one verdict per case and one
 * `fp eval` summary line the gate judge parses. The sheet's own `casesSha256`
 * is verified first so an edited sheet cannot pass as the recorded one.
 *
 * Usage:
 *   node scripts/fingerprint-eval.mjs [--set fixtures/fleet/p6-fingerprint-set.json]
 *
 * Lines (fixed, parsed by `p6-gate-check.mjs`):
 *   replay_seal fixtures=<path> sha256=<hex> cases=<n>
 *   fp case id=<id> expect=<same|diff> actual=<sig8> verdict=PASS|FAIL note="<cause>"
 *   fp eval same=<m>/<n> diff=<k>/<l> hit=<pct>%
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { evaluateSamples } from '../packages/agent-cron-dashboard/src/fleet/fingerprint.ts'

const ROOT = resolve(import.meta.dirname, '..')
const argv = process.argv.slice(2)
const setIndex = argv.indexOf('--set')
const setPath = resolve(ROOT, setIndex >= 0 && argv[setIndex + 1] !== undefined ? argv[setIndex + 1] : 'fixtures/fleet/p6-fingerprint-set.json')
const raw = readFileSync(setPath)
const set = JSON.parse(raw.toString("utf8"))

// The sheet records the digest of its own cases array (sorted keys, the same JSON the generator wrote).
const sheetSha = set.casesSha256
const expectedCasesSha = createHash('sha256').update(JSON.stringify(sortDeep(set.cases))).digest('hex')
console.log(`replay_seal fixtures=${setPath.slice(ROOT.length + 1)} sha256=${createHash('sha256').update(raw).digest('hex')} cases=${String(set.cases.length)}`)

if (sheetSha === undefined || sheetSha !== expectedCasesSha) {
  console.log(`fp sheet INTEGRITY FAIL expected=${String(sheetSha)} actual=${expectedCasesSha}`)
  process.exitCode = 1
}

const verdict = evaluateSamples(set)
for (const entry of verdict.cases) {
  console.log(`fp case id=${entry.id} expect=${entry.expect} actual=${entry.signature.slice(0, 8)} verdict=${entry.verdict} note="${entry.cause.replace(/"/g, "'")}"`)
}
console.log(`fp eval same=${String(verdict.sameCauseMerged)}/${String(verdict.sameCauseTotal)} diff=${String(verdict.differentCauseSeparated)}/${String(verdict.differentCauseTotal)} hit=${verdict.hitRate.toFixed(1)}%`)
if (verdict.errors.length > 0) {
  for (const miss of verdict.errors) console.log(`fp miss id=${miss.id} expect=${miss.expect} actual=${miss.actual.slice(0, 8)} note="${miss.cause}"`)
  process.exitCode = 1
}

/** Deep key sort so the digest matches the generator's `sort_keys=True`. */
function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortDeep(value[key])]))
  }
  return value
}
