#!/usr/bin/env node
/**
 * G1/G2/G3 assertion runner (plan §5.0–§5.3).
 *
 * It only reads the log a gate produced (plus the two oracle JSON files for
 * G1) and prints `GATE <name> PASS/FAIL`; exit 0 means pass. The line formats it
 * parses are the plan's fixed ones (`seed …=[…]`, `round#N platform=…`,
 * `snapshot=…`, `health …`, `identity …`, `EXIT rc=`), so a formatting change
 * in the producers fails loudly instead of passing silently.
 *
 * Usage:
 *   node scripts/p2-gate-check.mjs --gate G1 --log ../docs/handoff/p2-g1.log \
 *     --oracle-github ../docs/handoff/p2-oracle-github.json --oracle-gitcode ../docs/handoff/p2-oracle-gitcode.json \
 *     --token-file ~/.gitcode_token
 *   node scripts/p2-gate-check.mjs --gate G2 --log ../docs/handoff/p2-g2.log
 *   node scripts/p2-gate-check.mjs --gate G3 --log ../docs/handoff/p2-g3.log
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

/** G1 thresholds (plan §5.5): same formula, per-platform measured period. */
const THRESHOLDS = { github: 23, gitcode: 125 }

function argOf(argv, name, fallback) {
  const index = argv.indexOf(name)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}

function linesOf(path) {
  return readFileSync(resolve(path), 'utf8').split('\n').filter((line) => line.length > 0)
}

function countContains(lines, needle) {
  return lines.filter((line) => line.includes(needle)).length
}

function roundCounts(lines) {
  // GitHub counts per PR: the same review key carries `pr=`, so the pair forms
  // the identity. GitCode counts one line per cover batch (platform level).
  const counts = { github: 0, gitcode: 0 }
  const perPr = new Map()
  for (const line of lines) {
    const match = /^round#(\d+) platform=(\w+) key=([^\s]+)(?: pr=(\d+))?/.exec(line)
    if (match === null) continue
    const platform = match[2]
    if (platform === 'github') perPr.set(`${match[3]}#${match[4] ?? ''}`, (perPr.get(`${match[3]}#${match[4] ?? ''}`) ?? 0) + 1)
    if (platform === 'github' || platform === 'gitcode') counts[platform] += 1
  }
  const lowest = perPr.size === 0 ? 0 : Math.min(...perPr.values())
  return { counts, githubPerKey: lowest, prCount: perPr.size }
}

function seedSet(lines, platform) {
  const line = lines.find((entry) => entry.startsWith(`seed ${platform}=`))
  if (line === undefined) return undefined
  const raw = line.slice(`seed ${platform}=`.length).trim()
  try {
    const value = JSON.parse(raw)
    return Array.isArray(value) ? value.map(String).sort() : undefined
  } catch {
    return undefined
  }
}

function checkG1(argv) {
  const lines = linesOf(argOf(argv, '--log'))
  const problems = []
  const githubOracle = JSON.parse(readFileSync(resolve(argOf(argv, '--oracle-github')), 'utf8'))
  const gitcodeOracle = JSON.parse(readFileSync(resolve(argOf(argv, '--oracle-gitcode')), 'utf8'))
  const round = roundCounts(lines)
  for (const platform of ['github', 'gitcode']) {
    const actual = seedSet(lines, platform)
    const expected = [...(platform === 'github' ? githubOracle.github : gitcodeOracle.gitcode)].map(String).sort()
    if (actual === undefined) problems.push(`seed ${platform}= line missing`)
    else if (JSON.stringify(actual) !== JSON.stringify(expected)) problems.push(`seed ${platform} differs: log=${JSON.stringify(actual)} oracle=${JSON.stringify(expected)}`)
  }
  // GitHub: one `round#` line per PR and tick; GitCode: one per cover batch,
  // fanned out to every watched key in that batch.
  if (round.prCount !== 3) problems.push(`github watched ${round.prCount} PR(s), expected 3`)
  if (round.githubPerKey < THRESHOLDS.github) problems.push(`github lowest per-PR rounds ${round.githubPerKey} < ${THRESHOLDS.github}`)
  if (round.counts.gitcode < THRESHOLDS.gitcode) problems.push(`gitcode rounds ${round.counts.gitcode} < ${THRESHOLDS.gitcode}`)
  // Seed health `up` is the norm; the GitCode 3-page truncation is tolerated
  // only when named as such (the set comparison above still decides).
  for (const seedLine of lines.filter((entry) => entry.startsWith('health community:seed:'))) {
    if (seedLine.includes('state=down')) problems.push(`seed health down: ${seedLine}`)
    if (seedLine.includes('state=degraded') && !seedLine.includes('3 full pages read')) problems.push(`seed health degraded for an unnamed reason: ${seedLine}`)
  }
  const snapshotLines = lines.filter((line) => line.startsWith('snapshot='))
  for (const platform of ['github', 'gitcode']) {
    if (!snapshotLines.some((line) => line.includes(`snapshot=${platform}/`))) problems.push(`no ${platform} snapshot line`)
  }
  if (!snapshotLines.every((line) => /rollup=(none|pending|success|failure)\b/.test(line))) problems.push('snapshot rollup outside the contract values')
  if (!lines.some((line) => line.startsWith('EXIT rc=0'))) problems.push('EXIT rc=0 line missing')
  const tokenFile = argOf(argv, '--token-file', resolve(homedir(), '.gitcode_token'))
  let secret = ''
  try {
    secret = readFileSync(resolve(tokenFile), 'utf8').trim()
  } catch {
    secret = ''
  }
  if (secret.length > 0) {
    const leaked = lines.filter((line) => line.includes(secret)).length
    if (leaked > 0) problems.push(`token appears in ${leaked} log line(s)`)
  }
  return problems
}

function checkG2(argv) {
  const lines = linesOf(argOf(argv, '--log'))
  const problems = []
  if (countContains(lines, 'XAI_P2_CANARY') !== 0) problems.push('canary leaked into the log')
  const starred = lines.filter((line) => line.includes('***'))
  if (starred.length < 1) problems.push('no *** line: redact path never ran')
  // `***` may only sit on the identity line or on the health line quoting its message.
  if (starred.some((line) => !line.startsWith('identity gitcode') && !line.startsWith('health community:seed:gitcode'))) {
    problems.push('*** outside the identity/seed health lines')
  }
  // The phrase appears twice by design: on the identity line and quoted inside
  // the seed health line. Exactly one *identity* line may carry it.
  const refusedIdentity = lines.filter((line) => line.startsWith('identity gitcode') && line.includes('GitCode /user refused')).length
  if (refusedIdentity !== 1) problems.push('"GitCode /user refused" must sit on exactly one identity line')
  if (countContains(lines, 'seed gitcode=[]') !== 1) problems.push('seed gitcode=[] must appear exactly once')
  if (lines.some((line) => line.startsWith('health community:seed:gitcode') && line.includes('state=degraded'))) problems.push('seed health must be down (platform skipped), not degraded')
  if (lines.some((line) => line.startsWith('health community:seed:gitcode') && line.includes('state=down')) === false) problems.push('seed health down line missing')
  if (countContains(lines, 'identity gitcode state=down') !== 1) problems.push('identity gitcode state=down must appear exactly once')
  return problems
}

function checkG3(argv) {
  const lines = linesOf(argOf(argv, '--log'))
  const text = lines.join('\n')
  const problems = []
  if (!lines.some((line) => line.startsWith('EXIT rc=0'))) problems.push('EXIT rc=0 line missing')
  const total = /TOTAL\t(\d+)/.exec(text)
  if (total === null) problems.push('TOTAL line missing')
  else if (Number(total[1]) < 201) problems.push(`TOTAL ${total[1]} < 201`)
  const summary = /Tests\s+\d+\s+passed[^\n]*/.exec(text)
  const skipped = summary === null ? 0 : Number((/(\d+)\s+skipped/.exec(summary[0]) ?? [])[1] ?? 0)
  const baseline = readFileSync(resolve(argOf(argv, '--baseline', resolve('../docs/handoff/p1-test-count.txt'))), 'utf8')
  const baselineSkip = Number((/skip=(\d+)/.exec(baseline) ?? [])[1] ?? 0)
  if (skipped !== baselineSkip) problems.push(`skipped ${skipped} != baseline ${baselineSkip}`)
  if (countContains(lines, 'COVERAGE-GATE PASS') !== 1) problems.push('COVERAGE-GATE PASS must appear exactly once')
  if (countContains(lines, 'MIRROR PASS') !== 1) problems.push('MIRROR PASS must appear exactly once')
  return problems
}

const argv = process.argv.slice(2)
const gate = argOf(argv, '--gate', 'G1').toUpperCase()
const problems = gate === 'G1' ? checkG1(argv) : gate === 'G2' ? checkG2(argv) : checkG3(argv)
const verdict = problems.length === 0 ? 'PASS' : 'FAIL'
console.log(`GATE ${gate} ${verdict}`)
for (const problem of problems) console.log(`  - ${problem}`)
process.exit(problems.length === 0 ? 0 : 1)
