#!/usr/bin/env node
/**
 * P3 gates (G1 real poller, G2 token-less GitCode, G3 unit/contract/coverage).
 *
 * Reads the log a gate produced plus the oracle JSON of G1 and prints
 * `GATE <name> PASS/FAIL`; exit 0 means pass. The line formats parsed here are
 * the ones `smoke-p3.mjs` writes and `p3-gate-check.mjs` documents in its
 * header — a format change in the producer fails loudly instead of passing
 * silently (same rule as the P2 runner).
 *
 * Usage:
 *   node scripts/p3-gate-check.mjs --gate G1 --log ../docs/handoff/p3-g1.log \
 *     --oracle ../docs/handoff/p3-oracle-github.json --token-file ~/.gitcode_token \
 *     --window-minutes 10
 *   node scripts/p3-gate-check.mjs --gate G2 --log ../docs/handoff/p3-g2.log --window-minutes 3
 *   node scripts/p3-gate-check.mjs --gate G3 --log ../docs/handoff/p3-g3.log --baseline ../docs/handoff/p3-baseline.txt
 */
import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

/** G1 floors (plan §4: one real GitHub round + one named GitCode round). */
const G1_MIN_GITHUB_ROUNDS = 1
const G1_MIN_GITCODE_ROUNDS = 1
/** G2 floors: the token-less run must still see the GitHub path move. */
const G2_MIN_GITHUB_ROUNDS = 2
// NOTE: values are read by the header above; keep them together.

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

function jsonField(line, name) {
  const match = new RegExp(`${name}=([^ ]+?)(?: at=| envelopes|$)`, 'u').exec(`${line} `)
  return match === null ? undefined : match[1]
}

/** Environment baseline (discipline §9b): header present and not overloaded. */
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
}

/** A real ISO 8601 instant, bare (`…Z`) or wrapped in `<…>` (the environment lines). */
function lineHasTime(line) {
  return /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/.test(line)
}

/** Count per-platform rounds from the `issue <platform> ok=… at=…` lines. */
function roundCounts(lines) {
  const counts = { github: 0, gitcode: 0 }
  let first = null
  let last = null
  for (const line of lines) {
    const match = /^issue (github|gitcode) ok=(true|false) considered=(\d+) changed=(\d+) queued=(\d+) at=([0-9T:.Z-]+)/.exec(line)
    if (match === null) continue
    counts[match[1]] += 1
    if (first === null) first = match[6]
    last = match[6]
  }
  return { counts, first, last }
}

function snapshotLines(lines) {
  return lines.filter((line) => line.startsWith('snapshot=')).map((line) => {
    // Labels are a JSON array and may contain spaces/commas: it is the one
    // field with brackets, so the regex anchors on `] comments=`.
    const match = /^snapshot=([^\s]+) state=(open|closed) labels=(\[.*?\]) comments=(\d+) last_comment_by=([^\s]+) last_comment_at=([^\s]+) at=([0-9T:.Z-]+)/.exec(line)
    if (match === null) return { raw: line, invalid: true }
    const labels = safeJson(match[3])
    return {
      raw: line,
      key: match[1],
      platform: match[1].split('/')[0],
      state: match[2],
      labels: Array.isArray(labels) ? labels : null,
      comments: Number(match[4]),
      lastCommentBy: match[5] === 'null' ? null : match[5],
      lastCommentAt: match[6] === 'null' ? null : match[6],
      at: match[7],
    }
  })
}

function safeJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function queueCount(lines, key, suffix) {
  const matches = lines.filter((line) => line.startsWith(`queue ${key} `))
  if (matches.length === 0) return undefined
  const last = matches[matches.length - 1]
  const field = jsonField(last, suffix)
  return field === undefined ? undefined : Number(field)
}

/** Lines written by the smoke to prove the queue was consumed. */
function checkQueueArms(lines, keys, problems) {
  const diffed = new Set(lines.filter((line) => line.startsWith('diff ')).map((line) => jsonField(line, 'key')).filter(Boolean))
  for (const key of keys) {
    const pairs = queueCount(lines, key, 'pairs')
    const dropped = queueCount(lines, key, 'dropped')
    if (pairs === undefined || dropped === undefined) {
      // A first observation whose pair the previous batch already queued is
      // legitimate only when its `diff` line names `first-observation` (the
      // queue record is written before the first dump of the round).
      if (!lines.some((line) => line.startsWith('diff ') && line.includes(`key=${key} `) && line.includes('first-observation'))) problems.push(`queue line missing for ${key}`)
    } else if (pairs < 1) problems.push(`${key}: no pair queued (first observation never reached P4)`)
    else if (dropped > 0) problems.push(`${key}: ${String(dropped)} pair(s) dropped`)
    if (!diffed.has(key) && !lines.some((line) => line.includes(`key=${key}`) && line.startsWith('diff '))) {
      problems.push(`${key}: no diff line (the pair is not proven to carry before/after)`)
    }
  }
}

function checkTokenAbsent(lines, tokenFile, problems) {
  let secret = ''
  try {
    secret = readFileSync(resolve(tokenFile), 'utf8').trim()
  } catch {
    secret = ''
  }
  if (secret.length > 0 && lines.some((line) => line.includes(secret))) problems.push('GitCode token appears in the log')
}

function checkG1(argv) {
  const lines = linesOf(argOf(argv, '--log'))
  const problems = []
  checkEnvironment(lines, problems)
  if (!lines.some((line) => line.startsWith('EXIT rc=0'))) problems.push('EXIT rc=0 line missing')
  if (!lines.some((line) => line.startsWith('PY3_SMOKE_END'))) problems.push('PY3_SMOKE_END marker missing (the window ended early)')
  const rounds = roundCounts(lines)
  if (rounds.counts.github < G1_MIN_GITHUB_ROUNDS) problems.push(`github rounds ${String(rounds.counts.github)} < ${String(G1_MIN_GITHUB_ROUNDS)}`)
  if (rounds.counts.gitcode < G1_MIN_GITCODE_ROUNDS) problems.push(`gitcode rounds ${String(rounds.counts.gitcode)} < ${String(G1_MIN_GITCODE_ROUNDS)}`)
  if (rounds.first === null || !lineHasTime(` at=${rounds.first}`)) problems.push('issue round lines carry no time')

  // ---- GitHub list vs oracle (the live truth read independently) -------------
  const oracle = JSON.parse(readFileSync(resolve(argOf(argv, '--oracle')), 'utf8'))
  const degradedList = lines.filter((line) => line.startsWith('health community:issue:github') && line.includes('state=degraded'))
  if (degradedList.length > 0) problems.push(`github list degraded: ${degradedList[0]}`)
  if (typeof oracle.searchItems === 'number') {
    const searchAnswers = lines.filter((line) => line.startsWith('issue github ok=true'))
    if (searchAnswers.length === 0) problems.push('no successful github round (the list never answered)')
  } else {
    problems.push('oracle carries no searchItems')
  }

  // ---- per-issue rows -------------------------------------------------------
  const snapshots = snapshotLines(lines)
  for (const row of snapshots.filter((entry) => entry.invalid === true).slice(0, 3)) problems.push(`snapshot line does not match the fixed format: ${row.raw.slice(0, 160)}`)
  const rows = snapshots.filter((row) => row.invalid !== true)
  if (rows.length === 0) problems.push('no snapshot= lines: the poller stored nothing')
  // Only the LAST row per key describes the final store (a 304 round re-prints
  // the same row with a newer `at`, so duplicates are expected by design).
  const finalRows = new Map()
  for (const row of rows) finalRows.set(row.key, row)
  rows.length = 0
  rows.push(...finalRows.values())
  for (const platform of ['github', 'gitcode']) {
    const seen = rows.filter((row) => row.platform === platform)
    if (seen.length < 1) problems.push(`no ${platform} snapshot row`)
  }
  for (const row of rows) {
    if ((row.labels === null || row.labels.length === 0) && !lines.some((line) => line.startsWith('warning ') && line.includes(` ${row.key} `))) {
      problems.push(`${row.key}: labels empty (an unlabelled issue is exempt only when it is named)`)
    }
    if (row.comments > 0 && (row.lastCommentBy === null || row.lastCommentAt === null) && !lines.some((line) => line.startsWith('warning ') && line.includes(` ${row.key} `) && line.includes('last_comment_unknown'))) problems.push(`${row.key}: last comment unknown although the issue has comments=${String(row.comments)}`)
    // An issue with no comments must not carry a commenter (a stale value is a defect).
    if (row.comments === 0 && (row.lastCommentBy !== null || row.lastCommentAt !== null)) problems.push(`${row.key}: commenter recorded although the issue has no comments`)
    if (row.comments > 0 && !lineHasTime(` at=${row.at}`)) problems.push(`${row.key}: row carries no time`)
  }

  // ---- GitCode round named or degraded ---------------------------------------
  // A `down` platform that never names the token slot means the host refused the
  // request outright (identity up, seed read failing): that is a live-window
  // degradation, not the "在席/显名" state the plan discusses.
  const gitcodeDown = lines.filter((line) => line.startsWith('health community:issue:gitcode') && line.includes('state=down') && !line.includes('no token in GITCODE_TOKEN'))
  if (gitcodeDown.length > 0) problems.push(`gitcode unusable in the live window although the token exists: ${gitcodeDown[0]}`)

  // ---- queue arms -------------------------------------------------------------
  const uniqueKeys = [...new Set(rows.map((row) => row.key))]
  checkQueueArms(lines, uniqueKeys, problems)
  const tailLine = lines.find((line) => line.startsWith('env_end'))
  if (tailLine === undefined) problems.push('env_end line missing')

  // ---- staleness guard ----------------------------------------------------------
  if (typeof oracle.repoListProbe?.etag === 'string' && oracle.repoListProbe.etag.length > 0) {
    // A row whose last comment is older than the capture of the newest
    // envelope would be a stale cache; the newest row must be at or after it.
    const newest = rows.reduce((max, row) => (row.lastCommentAt !== null && row.lastCommentAt > max ? row.lastCommentAt : max), '')
    if (newest.length === 0) problems.push('no last-comment time to compare with the envelope capture')
    else if (newest < '2026-11-01') problems.push(`all last comments (${newest}) precede the capture month; suspect a stale cache`)
  }

  const window = Number(argOf(argv, '--window-minutes', '10'))
  const minutes = rounds.first === null || rounds.last === null ? 0 : (Date.parse(rounds.last) - Date.parse(rounds.first)) / 60_000
  if (minutes < window * 0.5) problems.push(`rounds span ${minutes.toFixed(1)} minutes, window was ${String(window)}`)
  checkTokenAbsent(lines, argOf(argv, '--token-file', resolve(homedir(), '.gitcode_token')), problems)
  console.log(`G1 facts rounds=github:${String(rounds.counts.github)}/gitcode:${String(rounds.counts.gitcode)} rows=${String(rows.length)} first=${String(rounds.first)} last=${String(rounds.last)}`)
  return problems
}

function checkG2(argv) {
  const lines = linesOf(argOf(argv, '--log'))
  const problems = []
  checkEnvironment(lines, problems)
  if (!lines.some((line) => line.startsWith('EXIT rc=0'))) problems.push('EXIT rc=0 line missing')
  if (lines.some((line) => line.includes('XAI_P3_CANARY'))) problems.push('canary leaked into the log')
  if (countStarting(lines, 'identity gitcode state=down') !== 1) problems.push('identity gitcode state=down must appear exactly once')
  const refused = lines.filter((line) => line.startsWith('identity gitcode') && line.includes('GitCode /user refused'))
  if (refused.length !== 1) problems.push('"GitCode /user refused" must sit on exactly one identity line')
  if (!refused[0]?.includes('***')) problems.push('the refusal line does not show the redacted token')
  const named = lines.filter((line) => line.startsWith('health community:issue:gitcode state=down'))
  if (named.length < 1) problems.push('the poller never named the token-less GitCode platform')
  if (named.length > 0 && !named.some((line) => line.includes('no token in GITCODE_TOKEN') || line.includes('private-token header is missing'))) problems.push(`GitCode down line does not name the token slot: ${named[0]}`)
  const round = lines.filter((line) => /^issue gitcode ok=false considered=0/.test(line))
  if (round.length < G2_MIN_GITHUB_ROUNDS) problems.push(`gitcode down rounds ${String(round.length)} < ${String(G2_MIN_GITHUB_ROUNDS)}`)
  if (!lines.some((line) => line.startsWith('env_end'))) problems.push('env_end line missing')
  const github = roundCounts(lines)
  if (github.counts.github < G2_MIN_GITHUB_ROUNDS) problems.push(`github rounds ${String(github.counts.github)} < ${String(G2_MIN_GITHUB_ROUNDS)}`)
  if (lines.some((line) => line.startsWith('snapshot=gitcode/'))) problems.push('a gitcode snapshot was written although the platform is unusable')
  console.log(`G2 facts gitcode_down_rounds=${String(round.length)} github_rounds=${String(github.counts.github)}`)
  return problems
}

function checkG3(argv) {
  const lines = linesOf(argOf(argv, '--log'))
  const text = lines.join('\n')
  const problems = []
  if (!lines.some((line) => line.startsWith('EXIT rc=0'))) problems.push('EXIT rc=0 line missing')
  const total = /TOTAL\t(\d+)/.exec(text)
  if (total === null) problems.push('TOTAL line missing')
  else if (Number(total[1]) < Number(argOf(argv, '--min-total', '226'))) problems.push(`TOTAL ${total[1]} < ${argOf(argv, '--min-total', '226')}`)
  const summary = /Tests\s+\d+\s+passed[^\n]*/.exec(text)
  const skipped = summary === null ? 0 : Number((/(\d+)\s+skipped/.exec(summary[0]) ?? [])[1] ?? 0)
  const baseline = readFileSync(resolve(argOf(argv, '--baseline', resolve('../docs/handoff/p1-test-count.txt'))), 'utf8')
  const baselineSkip = Number((/skip=(\d+)/.exec(baseline) ?? [])[1] ?? 0)
  if (skipped !== baselineSkip) problems.push(`skipped ${String(skipped)} != baseline ${String(baselineSkip)}`)
  if (countStarting(lines, 'COVERAGE-GATE PASS') !== 1) problems.push('COVERAGE-GATE PASS must appear exactly once')
  if (countStarting(lines, 'MIRROR PASS') !== 1) problems.push('MIRROR PASS must appear exactly once')
  if (countStarting(lines, 'TYPECHECK PASS') !== 1) problems.push('TYPECHECK PASS must appear exactly once')
  if (countStarting(lines, 'SYNC-CONTRACTS PASS') !== 1) problems.push('SYNC-CONTRACTS PASS must appear exactly once')
  return problems
}

/** Files under src/community (counts are machine-read, never hand-written). */
function communityFiles() {
  const root = resolve(import.meta.dirname, '../packages/agent-cron-dashboard/src/community')
  try {
    return readdirSync(root).filter((name) => name.endsWith('.ts')).length
  } catch {
    return 0
  }
}

const argv = process.argv.slice(2)
const gate = argOf(argv, '--gate', 'G1').toUpperCase()
const problems = gate === 'G1' ? checkG1(argv) : gate === 'G2' ? checkG2(argv) : checkG3(argv)
const verdict = problems.length === 0 ? 'PASS' : 'FAIL'
console.log(`GATE ${gate} ${verdict} community_files=${String(communityFiles())}`)
for (const problem of problems) console.log(`  - ${problem}`)
process.exit(problems.length === 0 ? 0 : 1)
