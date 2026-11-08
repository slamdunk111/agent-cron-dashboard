#!/usr/bin/env node
/**
 * P5 gate judge: parses the fixed smoke log (`p5-g1.log`) and the G3 log
 * (`p5-g3.log`) and returns rc=0 only when every assertion holds.
 *
 * Usage:
 *   node scripts/p5-gate-check.mjs --gate G1 --log ../docs/handoff/p5-g1.log
 *   node scripts/p5-gate-check.mjs --gate G3 --log ../docs/handoff/p5-g3.log --min-total 401 --baseline ../docs/handoff/p5-baseline.txt
 */
import { readFileSync } from 'node:fs'

function argOf(argv, name, fallback) {
  const index = argv.indexOf(name)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}

/** The four P5 keys written into the P4 event domain. */
const P5_KINDS = ['run-failed', 'run-recovered', 'source-health-down', 'source-health-recovered']

/** Secret-looking tokens the log must not contain. */
const SECRET_RE = [/sk-[A-Za-z0-9]{8,}/, /ghp_[A-Za-z0-9]{8,}/, /Bearer [A-Za-z0-9._-]+/, /glpat-[A-Za-z0-9]{8,}/]

const failures = []
const note = (ok, text) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${text}`)
  if (!ok) failures.push(text)
}

function judgeG1(text) {
  const lines = text.split('\n')
  note(lines.some((line) => line.startsWith('env ') && /loads=<\d{4}-/.test(line)), 'env header carries a capture time')
  note(!lines.some((line) => line.startsWith('env_state OVERLOADED')), 'environment not overloaded')
  note(lines.some((line) => line.startsWith('env_end at=')), 'env_end present')
  note(lines.includes('p5_smoke_end'), 'p5_smoke_end marker present')
  note(/EXIT rc=0/.test(text), 'EXIT rc=0 in the log')

  // fixture replay: the measured samples were replayed through every adapter
  const replay = lines.filter((line) => /^replay source=/.test(line))
  note(replay.length >= 2, `replay segments >=2 (got ${String(replay.length)})`)
  const numbers = lines.find((line) => line.startsWith('replay numbers ')) ?? ''
  const pairs = [...numbers.matchAll(/(\w+)=(\d+)\/(\d+)/g)]
  note(pairs.length >= 3, `replay numbers carry fixture comparisons (got ${String(pairs.length)})`)
  note(pairs.every((pair) => pair[2] === pair[3]), 'every replayed count equals the fixture count')

  // nas three rounds, monotone cursor, at least one round with runs and one with script_error
  const nas = lines.filter((line) => line.startsWith('nas round='))
  note(nas.length >= 3, `nas rounds >=3 (got ${String(nas.length)})`)
  const nasRc = nas.every((line) => line.includes('rc=0'))
  note(nasRc, 'every nas round rc=0')
  const cursors = nas.map((line) => Number((line.match(/cursor=(\d+)/) ?? [])[1] ?? 0))
  note(cursors.every((value, index) => index === 0 || value >= cursors[index - 1]), 'nas cursor monotone')
  const nasRuns = nas.map((line) => Number((line.match(/runs=(\d+)/) ?? [])[1] ?? 0))
  note(nasRuns.some((value) => value > 0), 'nas pulled at least one run row')
  const scriptErrors = nas.map((line) => Number((line.match(/script_error=(\d+)/) ?? [])[1] ?? 0))
  note(scriptErrors.some((value) => value > 0), 'nas round replaying historical script_error rows')
  note(nas.every((line) => /at=\d{4}-\d{2}-\d{2}T/.test(line)), 'nas rounds carry timestamps')

  // gmk three rounds up with 34 jobs
  const gmk = lines.filter((line) => line.startsWith('gmk round='))
  note(gmk.length >= 3, `gmk rounds >=3 (got ${String(gmk.length)})`)
  note(gmk.every((line) => line.includes('health=up')), 'gmk health=up every round')
  note(gmk.every((line) => /jobs=34/.test(line)), 'gmk job list is the measured 34')
  note(gmk.every((line) => /at=\d{4}-\d{2}-\d{2}T/.test(line)), 'gmk rounds carry timestamps')

  // injected failure: down with a growing backoff while the others stay up
  const bad = lines.filter((line) => line.startsWith('bad round='))
  note(bad.length >= 1, 'injected ssh failure round present')
  note(bad.every((line) => line.includes('health=down')), 'injected failure reported down')
  const backoffs = bad.map((line) => Number((line.match(/backoff=(\d+)/) ?? [])[1] ?? 0))
  note(backoffs.length === 0 || backoffs[0] > 0, 'injected failure carries a backoff')
  if (bad.length >= 2) {
    note(backoffs.every((value, index) => index === 0 || value >= backoffs[index - 1]), 'backoff grows')
  }

  // fleet events use only the frozen four keys
  const events = lines.filter((line) => line.startsWith('fleet_event ') || line.startsWith('replay_event '))
  note(events.length >= 1, 'at least one graded fleet event')
  const kinds = events.map((line) => (line.match(/kind=([a-z-]+)/) ?? [])[1] ?? '')
  note(kinds.every((kind) => P5_KINDS.includes(kind)), 'event kinds stay inside the P5 subset')
  note(events.every((line) => /at=\d{4}-\d{2}-\d{2}T|key=/.test(line)), 'events carry key/time')

  // status tool fleet section is real
  const status = lines.find((line) => line.startsWith('status scope=fleet'))
  note(status !== undefined, 'fleet status line present')
  note(status !== undefined && /fleet="fleet: \d+ job\(s\)/.test(status), 'fleet status shows a job count instead of the placeholder')

  // no secret-shaped strings
  note(!SECRET_RE.some((pattern) => pattern.test(text)), 'log holds no secret-shaped token')
}

function judgeG3(text, minTotal, baseline) {
  note(/EXIT rc=0/.test(text), 'EXIT rc=0')
  const total = Number((text.match(/TOTAL\s+(\d+)/) ?? [])[1] ?? 0)
  note(total >= minTotal, `TOTAL >= ${String(minTotal)} (got ${String(total)})`)
  const tests = text.match(/Tests\s+(\d+) passed \((\d+)\)/)
  note(tests !== null, 'Tests passed line present')
  if (tests !== null) {
    note(Number(tests[1]) === total, 'test count equals TOTAL count')
  }
  if (baseline !== null) {
    const skip = Number((readFileSync(baseline, 'utf8').match(/skip=(\d+)/) ?? [])[1] ?? 0)
    const reported = Number((text.match(/(\d+) skipped/) ?? [])[1] ?? 0)
    note(reported === skip, `skip count unchanged (baseline ${String(skip)}, got ${String(reported)})`)
  }
  note(text.includes('COVERAGE-GATE PASS'), 'coverage gate PASS for the seven fleet files')
  note(text.includes('MIRROR PASS'), 'plan mirror PASS')
  note(text.includes('TYPECHECK PASS'), 'typecheck PASS')
  note(text.includes('SYNC-CONTRACTS PASS'), 'contract sync PASS')
}

function main(argv) {
  const gate = argOf(argv, '--gate', 'G1')
  const log = argOf(argv, '--log', '')
  if (log === '') {
    console.error('missing --log')
    return 2
  }
  const text = readFileSync(log, 'utf8')
  if (gate === 'G1') judgeG1(text)
  else judgeG3(text, Number(argOf(argv, '--min-total', '401')), argOf(argv, '--baseline', null))
  const verdict = failures.length === 0 ? 'PASS' : 'FAIL'
  console.log(`GATE ${gate} ${verdict} (${String(failures.length)} failure(s))`)
  return failures.length === 0 ? 0 : 1
}

process.exitCode = main(process.argv.slice(2))
