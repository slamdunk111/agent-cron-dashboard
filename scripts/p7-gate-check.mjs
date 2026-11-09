#!/usr/bin/env node
/**
 * P7 gate judge: parses the fixed logs (`p7-g1p.log`, `p7-empty.log`,
 * `p7-g3.log`) and returns rc=0 only when every assertion holds.
 *
 * The line formats parsed here are exactly the ones `p7-run-gates.py` writes
 * (its header documents the same templates); a format change in the producer
 * fails loudly instead of passing silently (same rule as the P2–P6 judges).
 *
 * Usage:
 *   node scripts/p7-gate-check.mjs --selftest
 *   node scripts/p7-gate-check.mjs --gate G1-P|G-EMPTY|G3 --log <path> [--min-total N]
 */
import { readFileSync, existsSync } from 'node:fs'

function argOf(argv, name, fallback) {
  const index = argv.indexOf(name)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}

const failures = []
const note = (ok, text) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${text}`)
  if (!ok) failures.push(text)
}

function linesOf(path) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter((line) => line.length > 0)
}

const find = (lines, prefix) => lines.find((line) => line.startsWith(prefix)) ?? ''
const countOf = (lines, prefix) => lines.filter((line) => line.startsWith(prefix)).length
const field = (line, key) => {
  const match = new RegExp(`${key}=([^ ]+)`).exec(line)
  return match === null ? '' : match[1]
}
const ISO_WITH_OFFSET = /at=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?\+08:00)/

function judgeG1P(lines) {
  note(lines.length > 0, 'log not empty')
  const env = find(lines, 'env ')
  note(/load=|nproc=/.test(env) && ISO_WITH_OFFSET.test(env), `env line carries load/nproc/at: ${env.slice(0, 80)}`)
  const version = find(lines, 'probe dsh version=')
  note(field(version, 'version') === '0.2.2-rc.1', 'probe dsh version=0.2.2-rc.1')
  const home = find(lines, 'probe home-isolation ')
  note(field(home, 'ok') === 'yes', 'probe home-isolation ok=yes')
  note(field(home, 'home').startsWith('/tmp/p7-e2e/') || field(home, 'home') === 'n/a', 'home under /tmp/p7-e2e or named n/a')
  const storage = find(lines, 'probe storage domains=')
  note(field(storage, 'domains') === '8', `probe storage domains=8 (got ${field(storage, 'domains')})`)
  note(field(storage, 'tables') !== '', 'probe storage names the six tables')
  const registered = find(lines, 'probe route registered=')
  note(field(registered, 'registered') === 'yes', 'probe route registered=yes')
  const http = find(lines, 'probe route http ')
  note(field(http, 'status') === '200', 'probe route http status=200')
  note(field(http, 'content_type') === 'application/json', 'probe route http content_type=application/json')
  note(field(http, 'route') === 'resource', 'probe route http route=resource (fallback would mean the route is shadowed)')
  note(field(http, 'sha256').length === 64, 'probe route http carries a sha256')
  note(field(http, 'match') === 'yes', 'probe route http match=yes (body equals the in-process recompute)')
  note(ISO_WITH_OFFSET.test(http), 'probe route http carries at=<ISO+08:00>')
  const empty = find(lines, 'probe route empty status=')
  note(field(empty, 'status') === '200' && field(empty, 'missing') === '6', 'probe route empty answers 200 with six missing domains')
  const owner = find(lines, 'probe owner-storage untouched=')
  note(field(owner, 'untouched') === 'yes', 'probe owner-storage untouched=yes')
  note(lines.some((line) => line.startsWith('EXIT rc=')), 'closing EXIT rc= line')
}

function judgeEmpty(lines) {
  note(lines.length > 0, 'log not empty')
  const domains = lines.filter((line) => line.startsWith('empty domain='))
  note(domains.length === 6, `six empty domain rows (got ${domains.length})`)
  for (const line of domains) note(field(line, 'present') === 'no' && field(line, 'state') === 'empty', `${field(line, 'domain')} present=no state=empty`)
  const http = find(lines, 'probe route empty status=')
  note(field(http, 'status') === '200' && field(http, 'missing') === '6', 'empty snapshot still answers 200 with six missing domains')
  note(lines.some((line) => line.startsWith('EXIT rc=')), 'closing EXIT rc= line')
}

function judgeG3(lines, minTotal) {
  note(lines.length > 0, 'log not empty')
  const tests = find(lines, 'tests total=')
  note(field(tests, 'total') !== '' && Number(field(tests, 'total')) >= minTotal, `tests total=${field(tests, 'total')} >= ${minTotal}`)
  note(field(tests, 'skipped') === '0', 'tests skipped=0')
  for (const name of ['COVERAGE', 'TYPECHECK', 'SYNC-CONTRACTS', 'MIRROR']) {
    const line = find(lines, `gate line=`)
    const rows = lines.filter((entry) => entry.startsWith('gate line=') && field(entry, 'name') === name)
    note(rows.length === 1 && field(rows[0], 'line') === 'PASS', `gate ${name} PASS`)
    void line
  }
  note(lines.some((line) => line.startsWith('EXIT rc=')), 'closing EXIT rc= line')
}

function selftest() {
  const ok = [
    'env load=1.0 nproc=32 at=2026-11-09T20:20:00.000+08:00',
    'probe dsh version=0.2.2-rc.1 at=2026-11-09T20:20:00.000+08:00',
    'probe home-isolation ok=yes home=/tmp/p7-e2e/home at=2026-11-09T20:20:00.000+08:00',
    'probe storage domains=8 tables=pr,issue,jobs,errors,events,health at=2026-11-09T20:20:00.000+08:00',
    'probe route registered=yes at=2026-11-09T20:20:00.000+08:00',
    'probe route http status=200 content_type=application/json bytes=120 sha256=' + 'a'.repeat(64) + ' route=resource match=yes at=2026-11-09T20:20:00.000+08:00',
    'probe route empty status=200 missing=6 at=2026-11-09T20:20:00.000+08:00',
    'probe owner-storage untouched=yes newer=0 at=2026-11-09T20:20:00.000+08:00',
    'EXIT rc=0',
  ]
  const bad = ['probe route http status=500 content_type=text/html route=fallback match=no', 'EXIT rc=1']
  judgeG1P(ok)
  const failuresAfterOk = failures.length
  failures.length = 0
  judgeG1P(bad)
  const caught = failures.length > 0
  failures.length = 0
  console.log(`SELFTEST ${failuresAfterOk === 0 && caught ? 'PASS' : 'FAIL'}`)
  process.exit(failuresAfterOk === 0 && caught ? 0 : 1)
}

const argv = process.argv.slice(2)
if (argv.includes('--selftest')) selftest()
else {
  const gate = argOf(argv, '--gate', '')
  const log = argOf(argv, '--log', '')
  const minTotal = Number(argOf(argv, '--min-total', '0'))
  const lines = linesOf(log)
  if (gate === 'G1-P') judgeG1P(lines)
  else if (gate === 'G-EMPTY') judgeEmpty(lines)
  else if (gate === 'G3') judgeG3(lines, minTotal)
  else {
    console.log(`FAIL unknown gate ${gate}`)
    process.exit(2)
  }
  console.log(failures.length === 0 ? `GATE ${gate} PASS (0 failure(s))` : `GATE ${gate} FAIL (${failures.length} failure(s))`)
  process.exit(failures.length === 0 ? 0 : 1)
}
