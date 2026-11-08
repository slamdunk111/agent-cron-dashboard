#!/usr/bin/env node
/**
 * P4 gates (G1 real window + fake seed, G3 unit/coverage/mirror/type/contracts).
 *
 * Reads the log the gate driver produced and prints `GATE <name> PASS/FAIL`;
 * exit 0 means pass. The line formats parsed here are exactly the ones
 * `smoke-p4.mjs` documents in its header: a format change in the producer
 * fails loudly instead of passing silently (same rule as the P2/P3 runners).
 *
 * Usage:
 *   node scripts/p4-gate-check.mjs --gate G1 --log ../docs/handoff/p4-g1.log --window-minutes 3
 *   node scripts/p4-gate-check.mjs --gate G3 --log ../docs/handoff/p4-g3.log --baseline ../docs/handoff/p4-baseline.txt
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

/** The frozen table must hold this many kinds (P3 head: 22). */
const EXPECTED_KINDS = 22

function argOf(argv, name, fallback) {
  const index = argv.indexOf(name)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}

function linesOf(path) {
  return readFileSync(resolve(path), 'utf8').split('\n').filter((line) => line.length > 0)
}

function countStarting(lines, prefix) {
  return lines.filter((line) => line.startsWith(prefix)).length
}

/** A real ISO 8601 instant (bare or inside `<…>`). */
function lineHasTime(line) {
  return /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/.test(line)
}

/** Environment baseline (discipline §9b): header present, not overloaded, end captured. */
function checkEnvironment(lines, problems) {
  const header = lines.find((line) => line.startsWith('env TZ_OFFSET='))
  if (header === undefined) {
    problems.push('environment header missing (discipline §9b: load/nproc must be recorded)')
    return
  }
  if (!lineHasTime(header)) problems.push('environment header carries no capture time')
  if (lines.some((line) => line.startsWith('env_state OVERLOADED'))) problems.push('environment was overloaded: readings only an upper bound')
  const end = lines.find((line) => line.startsWith('env_end loads=<'))
  if (end === undefined || !lineHasTime(end)) problems.push('env_end capture time missing (the "before and after" record is required)')
  // The live child has its own denominator; it must be recorded too (D6).
  if (!lines.some((line) => line.startsWith('live_child env_state') || line.startsWith('step live skipped'))) problems.push('live segment records neither a child env_state nor a named skip')
}

/** `seed kind=<kind> level=<level> emitted=<…>` rows, one per kind. */
function seedRows(lines) {
  const rows = []
  for (const line of lines) {
    const match = /^seed kind=([a-z-]+) level=(high|medium) emitted=(true|false|n\/a) at=([0-9T:.Z-]+)$/.exec(line) ??
      /^seed kind=([a-z-]+) level=(high|medium) emitted=(true|false|n\/a)$/.exec(line)
    if (match === null) continue
    rows.push({ kind: match[1], level: match[2], emitted: match[3], raw: line })
  }
  return rows
}

function checkG1(argv) {
  const lines = linesOf(argOf(argv, '--log'))
  const problems = []
  checkEnvironment(lines, problems)
  if (!lines.some((line) => line.startsWith('EXIT rc=0'))) problems.push('EXIT rc=0 line missing')
  if (!lines.some((line) => line.startsWith('P4_SMOKE_END'))) problems.push('P4_SMOKE_END marker missing (the smoke ended early)')

  // 3) the whole frozen table is seeded, and the fleet half is named as not produced here.
  const seeds = seedRows(lines)
  if (seeds.length !== EXPECTED_KINDS) problems.push(`seed rows ${String(seeds.length)} != ${String(EXPECTED_KINDS)} (the grading table must cover every frozen kind)`)
  for (const row of seeds) {
    if (!/emitted=(true|false|n\/a)/.test(row.raw)) problems.push(`seed row carries no emitted= field: ${row.raw}`)
  }
  const seededKinds = seeds.filter((row) => row.kind === 'pr-seeded' || row.kind === 'issue-seeded')
  if (seededKinds.length !== 2) problems.push('pr-seeded and issue-seeded must both sit in the seed table')
  for (const row of seededKinds) {
    if (row.level !== 'medium') problems.push(`${row.kind} is ${row.level}, the frozen table says medium`)
    if (row.emitted !== 'true') problems.push(`${row.kind} was never produced by the engine`)
  }
  const fleetRows = seeds.filter((row) => /^(run|source-health|error-record)/.test(row.kind))
  if (fleetRows.some((row) => row.emitted !== 'n/a')) problems.push('a fleet kind claims to have been produced by P4')

  // 4) first observation is digest material and never a card.
  if (countStarting(lines, 'seeded dispatched=0') !== 1) problems.push('the "no seeded card" line is missing or does not say 0')
  const seededEvents = lines.filter((line) => /^event .* kind=(pr-seeded|issue-seeded) /.test(line))
  if (seededEvents.length < 2) problems.push('fewer than two seeded events in the log')
  for (const line of seededEvents) {
    if (!line.includes('dispatch=digest')) problems.push(`a seeded event is not digest-only: ${line}`)
  }
  const eventLines = lines.filter((line) => line.startsWith('event '))
  if (eventLines.length === 0) problems.push('no event= lines: nothing was graded')
  for (const line of eventLines) {
    if (!lineHasTime(line)) problems.push(`event line carries no time: ${line.slice(0, 120)}`)
    const dispatch = /dispatch=(card|digest)/.exec(line)?.[1]
    const level = /level=(high|medium)/.exec(line)?.[1]
    if (dispatch !== undefined && level !== undefined && dispatch !== (level === 'high' ? 'card' : 'digest')) problems.push(`dispatch does not follow the level: ${line}`)
  }

  // 5) the stored path: the smoke ends with a count of stored events.
  const end = lines.find((line) => line.startsWith('P4_SMOKE_END'))
  const stored = /stored=(\d+)/.exec(end ?? '')?.[1]
  if (stored === undefined || Number(stored) < eventLines.length) problems.push(`stored events (${String(stored)}) are fewer than graded events (${String(eventLines.length)})`)

  // 6) the actionCards=false close-down path names the switch.
  const offState = lines.filter((line) => line.startsWith('notify_state actionCards=false'))
  if (offState.length !== 1) problems.push('the close-down notify_state row must appear exactly once')
  if (!lines.some((line) => line.includes('关闭态：事件只落库'))) problems.push('the close-down line does not name the switch')

  // 7) offline backlog handed over as one card.
  const cards = lines.filter((line) => line.startsWith('card action=workbench-notify'))
  if (cards.length !== 1) problems.push(`backlog cards ${String(cards.length)} != 1 (a backlog must be aggregated into one card)`)
  const cardCount = cards[0] === undefined ? 0 : Number(/events=(\d+)/.exec(cards[0])?.[1] ?? 0)
  if (cardCount < 2) problems.push(`aggregated card carries ${String(cardCount)} event(s), expected >=2`)
  if (cards[0] !== undefined && !cards[0].includes('reason=backlog')) problems.push('the aggregated card does not say reason=backlog')

  // 8) digest task: created once, unchanged on the second call, deleted when disabled.
  if (countStarting(lines, 'digest enabled=true action=created') !== 1) problems.push('digest task was not created exactly once')
  if (countStarting(lines, 'digest enabled=true action=unchanged') !== 1) problems.push('digest task was not reported unchanged on the second call')
  if (!lines.some((line) => line.startsWith('digest enabled=true action=unchanged') && line.includes('calls=create'))) problems.push('the idempotency line does not prove create was called once')
  if (countStarting(lines, 'digest enabled=false action=deleted') !== 1) problems.push('disabling the digest did not delete the task')
  for (const line of lines.filter((entry) => entry.startsWith('digest enabled=')) ) if (!lineHasTime(line)) problems.push(`digest line carries no time: ${line}`)

  // 9) the live window: at least one answering round, or a named skip/refusal.
  const liveLines = lines.filter((line) => line.startsWith('live '))
  const skipped = lines.filter((line) => line.startsWith('step live skipped'))
  if (liveLines.length === 0 && skipped.length === 0) problems.push('live segment produced neither rounds nor a named skip')
  for (const line of liveLines) if (!lineHasTime(line)) problems.push(`live round carries no time: ${line}`)
  const gitcodeRefusals = lines.filter((line) => line.startsWith('live_child health community:issue:gitcode'))
  if (gitcodeRefusals.length > 0) console.log(`G1 note: gitcode named ${String(gitcodeRefusals.length)} refusal line(s) (P3 probe §4b), see the log`)

  const window = Number(argOf(argv, '--window-minutes', '3'))
  if (window > 0 && liveLines.length > 0) {
    const stamps = liveLines.map((line) => /at=([0-9T:.Z-]+)/.exec(line)?.[1] ?? '').filter((value) => value.length > 0)
    const span = stamps.length < 2 ? 0 : (Date.parse(stamps.at(-1)) - Date.parse(stamps[0])) / 60_000
    if (span < window * 0.5 && liveLines.length > 1) problems.push(`live rounds span ${span.toFixed(1)} minutes, window was ${String(window)}`)
  }

  // 10) digests read the same stored events.
  const status = lines.find((line) => line.startsWith('status scope='))
  if (status === undefined) problems.push('status line missing (the tool never ran)')
  else if (!lineHasTime(status)) problems.push('status line carries no time')

  // 11) no token in the log (the smoke never reads one; this proves it).
  const secret = (() => {
    try {
      return readFileSync(resolve(homedir(), '.gitcode_token'), 'utf8').trim()
    } catch {
      return ''
    }
  })()
  if (secret.length > 0 && lines.some((line) => line.includes(secret))) problems.push('the GitCode token appears in the log')

  console.log(`G1 facts seeds=${String(seeds.length)} events=${String(eventLines.length)} stored=${String(stored ?? '?')} cards=${String(cards.length)} live_rounds=${String(liveLines.length)}`)
  return problems
}

function checkG3(argv) {
  const lines = linesOf(argOf(argv, '--log'))
  const text = lines.join('\n')
  const problems = []
  if (!lines.some((line) => line.startsWith('EXIT rc=0'))) problems.push('EXIT rc=0 line missing')
  const total = /TOTAL\t(\d+)/.exec(text)
  const minTotal = Number(argOf(argv, '--min-total', '251'))
  if (total === null) problems.push('TOTAL line missing')
  else if (Number(total[1]) < minTotal) problems.push(`TOTAL ${total[1]} < ${String(minTotal)}`)
  const summary = /Tests\s+\d+\s+passed[^\n]*/.exec(text)
  const skipped = summary === null ? 0 : Number((/(\d+)\s+skipped/.exec(summary[0]) ?? [])[1] ?? 0)
  const baseline = readFileSync(resolve(argOf(argv, '--baseline', resolve('../docs/handoff/p4-baseline.txt'))), 'utf8')
  const baselineSkip = Number((/skip=(\d+)/.exec(baseline) ?? [])[1] ?? 0)
  if (skipped !== baselineSkip) problems.push(`skipped ${String(skipped)} != baseline ${String(baselineSkip)}`)
  for (const marker of ['COVERAGE-GATE PASS', 'MIRROR PASS', 'TYPECHECK PASS', 'SYNC-CONTRACTS PASS']) {
    if (countStarting(lines, marker) !== 1) problems.push(`${marker} must appear exactly once`)
  }
  return problems
}

const argv = process.argv.slice(2)
const gate = argOf(argv, '--gate', 'G1').toUpperCase()
const problems = gate === 'G1' ? checkG1(argv) : checkG3(argv)
const verdict = problems.length === 0 ? 'PASS' : 'FAIL'
console.log(`GATE ${gate} ${verdict}`)
for (const problem of problems) console.log(`  - ${problem}`)
process.exit(problems.length === 0 ? 0 : 1)
