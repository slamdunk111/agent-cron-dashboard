#!/usr/bin/env node
/**
 * P6 gate judge: parses the fixed logs (`p6-g1.log`, `p6-g3.log`) and returns
 * rc=0 only when every assertion holds.
 *
 * The line formats parsed here are exactly the ones `smoke-p6.mjs` documents in
 * its header; a format change in the producer fails loudly instead of passing
 * silently (same rule as the P2/P3/P4/P5 judges).
 *
 * Usage:
 *   node scripts/p6-gate-check.mjs --gate G1 --log ../docs/handoff/p6-g1.log [--live]
 *   node scripts/p6-gate-check.mjs --gate G3 --log ../docs/handoff/p6-g3.log --min-total 545
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function argOf(argv, name, fallback) {
  const index = argv.indexOf(name)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}

const failures = []
const note = (ok, text) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${text}`)
  if (!ok) failures.push(text)
}

const linesOf = (path) => readFileSync(resolve(path), 'utf8').split('\n').filter((line) => line.length > 0)
const has = (lines, prefix) => lines.some((line) => line.startsWith(prefix))
const count = (lines, prefix) => lines.filter((line) => line.startsWith(prefix)).length
const numberIn = (line, key) => Number((new RegExp(`${key}=(\\d+(?:\\.\\d+)?)`).exec(line ?? '') ?? [])[1] ?? NaN)

/** Environment baseline (discipline §9b). */
function judgeEnvironment(lines) {
  const header = lines.find((line) => line.startsWith('env TZ_OFFSET='))
  note(header !== undefined && /loads=<\d{4}-\d{2}-\d{2}T/.test(header), 'env header carries a capture time')
  note(!lines.some((line) => line.startsWith('env_state OVERLOADED')), 'environment not overloaded')
  note(has(lines, 'env_end loads=<'), 'env_end present')
  note(has(lines, 'p6_smoke_end'), 'p6_smoke_end marker present')
}

function judgeG1(lines, live) {
  judgeEnvironment(lines)
  note(lines.some((line) => /^EXIT rc=0/.test(line)), 'EXIT rc=0 in the log')

  // #1 fingerprint sheet over the measured samples
  note(has(lines, 'replay_seal fixtures=fixtures/fleet/p6-fingerprint-set.json'), 'sheet seal line names the fixture file')
  const seal = lines.find((line) => line.startsWith('replay_seal ')) ?? ''
  note(/sha256=[0-9a-f]{64}/.test(seal), 'sheet seal carries a sha256')
  note(!has(lines, 'fp sheet INTEGRITY FAIL'), 'sheet digest matches its cases')
  const evalLine = lines.find((line) => line.startsWith('fp eval ')) ?? ''
  const same = /same=(\d+)\/(\d+)/.exec(evalLine)
  const diff = /diff=(\d+)\/(\d+)/.exec(evalLine)
  const hit = numberIn(evalLine, 'hit')
  note(same !== null && Number(same[1]) === Number(same[2]) && Number(same[2]) >= 15, `same-cause cases all merge (${evalLine})`)
  note(diff !== null && Number(diff[1]) === Number(diff[2]) && Number(diff[2]) >= 12, 'different-cause cases all stay apart')
  note(hit >= 90, `hit rate >= 90% (got ${String(hit)}%)`)
  const cases = lines.filter((line) => line.startsWith('fp case '))
  note(cases.length >= 27, `one verdict per sheet case (${String(cases.length)})`)
  note(cases.every((line) => line.includes('verdict=PASS')), 'every sheet case PASSes individually')
  note(!has(lines, 'fp miss '), 'no miss is recorded')

  // the playbooks: repair closure x3 and recurrence
  note(has(lines, 'script add kind=entity'), 'playbook registers one error entity')
  note(lines.some((line) => line.startsWith('script ingest ') && numberIn(line, 'count') >= 2 && /state=analyzed/.test(line)), 'dedupe counts the second occurrence')
  note(lines.some((line) => line.startsWith('script sample_ring=') && numberIn(line, 'sample_ring') === 5), 'sample ring holds exactly 5')
  note(lines.some((line) => line.startsWith('script analysis state=done')), 'analysis reached done (mock LLM)')
  note(lines.some((line) => line.startsWith('script resolve action=fix-applied') && /state=fix-applied/.test(line)), 'repair registered -> fix-applied')
  note(lines.some((line) => line.startsWith('script green streak=2') && /verified=no/.test(line) && /streak=2/.test(line)), 'N-1 green runs do not verify')
  note(lines.some((line) => line.startsWith('script green streak=3') && /verified=yes/.test(line) && /verified_at=2/.test(line)), 'exactly N green runs verify with an instant')
  note(lines.some((line) => line.startsWith('script reopen ') && /state=reopened/.test(line) && /labeled=yes/.test(line)), 'recurrence reopens and raises a high event')
  note(lines.some((line) => line.startsWith('script mask verdict=PASS')), 'mask holds over every measured sample')
  const keys = lines.find((line) => line.startsWith('script keys ')) ?? ''
  note(numberIn(keys, 'error-record-opened') >= 1 && numberIn(keys, 'error-record-reopened') >= 1 && numberIn(keys, 'error-record-verified') >= 1, `all three error-record keys written (${keys})`)
  const bridge = lines.find((line) => line.startsWith('script bridge ')) ?? ''
  note(Number(/script_error=(\d+)/.exec(bridge)?.[1] ?? 0) === Math.floor(Number(/rows=(\d+)/.exec(bridge)?.[1] ?? 0) / 2), 'bridge keeps every script_error of the measured rows')
  note(lines.some((line) => line.startsWith('status scope=fleet ') && /error record\(s\)/.test(line)), 'status tool reports ledger numbers')

  // #3 the real window
  if (live) {
    note(!has(lines, 'live skip reason='), 'live window did not skip')
    note(lines.some((line) => line.startsWith('live source=hermes-nas ') && /rc=0|entries=\d+/.test(line)), 'live nas read returned')
    const analysis = lines.find((line) => line.startsWith('live analysis ')) ?? ''
    note(/record=\S+ state=analyzed/.test(analysis), `live record reached analyzed (${analysis.slice(0, 90)})`)
    note(/model=\S+/.test(analysis) && !/model=none/.test(analysis), 'live analysis names the model')
    note(/at=\d{4}-\d{2}-\d{2}T/.test(analysis), 'live analysis carries a timestamp')
    note(numberIn(lines.find((line) => line.startsWith('live keys ')) ?? '', 'error-record-opened') >= 1, 'live window opened at least one record')
  } else {
    // A skip-CONTROL case: `--no-live` must be recorded by name and must never be
    // judged as G1 PASS (the gate needs the real window, plan §6.2 #3).
    note(has(lines, 'live skip reason='), 'live segment skipped by name')
    note(false, 'live window missing: G1 cannot pass without it (plan §6.2 #3)')
  }
}

function judgeG3(lines, minTotal) {
  const tests = lines.find((line) => /^\s*Tests\s+\d+ passed/.test(line)) ?? ''
  const passed = Number((/Tests\s+(\d+)\s+passed/.exec(tests) ?? [])[1] ?? 0)
  note(passed >= minTotal, `Tests passed >= ${String(minTotal)} (got ${String(passed)})`)
  note(!lines.some((line) => /\d+ skipped/.test(line)), 'no skipped tests')
  note(lines.some((line) => line.includes('COVERAGE-GATE PASS')), 'seven P6 files have zero uncovered lines')
  note(lines.some((line) => line.includes('MIRROR PASS')), 'plan mirror matches')
  note(has(lines, 'TYPECHECK PASS'), 'typecheck clean')
  note(has(lines, 'SYNC-CONTRACTS PASS'), 'generated contract copies are current')
  note(has(lines, 'P5-ZERO-REF PASS'), 'P5 sources still never name the three keys')
  note(has(lines, 'STATE-MATRIX PASS'), 'state machine matrix covers all 36 pairs')
  note(lines.some((line) => /^EXIT rc=0/.test(line)), 'EXIT rc=0 in the log')
}

const log = argOf(process.argv.slice(2), '--log', resolve(import.meta.dirname, '../../docs/handoff/p6-g1.log'))
const gate = argOf(process.argv.slice(2), '--gate', 'G1')
const lines = linesOf(log)
if (gate === 'G1') judgeG1(lines, process.argv.includes('--live'))
else judgeG3(lines, Number(argOf(process.argv.slice(2), '--min-total', '545')))
console.log(`GATE ${gate} ${failures.length === 0 ? 'PASS' : 'FAIL'} (${String(failures.length)} failure(s))`)
process.exitCode = failures.length === 0 ? 0 : 1
