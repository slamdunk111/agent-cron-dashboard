#!/usr/bin/env node
/**
 * P7 evidence summary: every number the report quotes comes from here.
 *
 * Reads the three fixed gate logs and the coverage file, prints one
 * `key=value` line per fact, and writes `../docs/handoff/p7-evidence.json`
 * with the same facts plus the log digests. Nothing in this file is
 * hand-written prose: a missing log is a failure, not a default.
 *
 * Usage: node scripts/p7-evidence-summary.mjs
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const handoff = resolve(root, '../docs/handoff')
const LOGS = {
  'g1p': resolve(handoff, 'p7-g1p.log'),
  'empty': resolve(handoff, 'p7-empty.log'),
  'g3': resolve(handoff, 'p7-g3.log'),
}

const missing = Object.entries(LOGS).filter(([, path]) => !existsSync(path)).map(([name]) => name)
if (missing.length > 0) {
  console.log(`EVIDENCE FAIL (missing log: ${missing.join(', ')})`)
  process.exit(1)
}

const linesOf = (path) => readFileSync(path, 'utf8').split('\n').filter((line) => line.length > 0)
const field = (line, key) => (new RegExp(`${key}=([^ ]+)`).exec(line) ?? [])[1] ?? ''
const find = (lines, prefix) => lines.find((line) => line.startsWith(prefix)) ?? ''
const sha256 = (text) => createHash('sha256').update(text).digest('hex')

const g1p = linesOf(LOGS.g1p)
const empty = linesOf(LOGS.empty)
const g3 = linesOf(LOGS.g3)

const gateLines = (lines) => lines.filter((line) => line.startsWith('gate line='))
// A verdict counts only when the judge line itself says PASS and appears once.
const verdictOf = (lines, gate) => {
  const rows = lines.filter((line) => line.startsWith(`GATE ${gate} `))
  return rows.length === 1 && /^GATE \S+ PASS\b/.test(rows[0]) ? 'PASS' : rows.length === 0 ? 'missing' : 'not-pass'
}
// Version must be the pinned release.
const verdictVersion = () => {
  const line = g1p.find((entry) => entry.startsWith('probe dsh version=')) ?? ''
  return (/version=([^ ]+)/.exec(line) ?? [])[1] ?? 'missing'
}
const oneGate = (lines, name) => {
  const rows = gateLines(lines).filter((line) => field(line, 'name') === name)
  return rows.length === 1 ? field(rows[0], 'line') : `ambiguous(${rows.length})`
}

const facts = {
  gateG1P: field(find(g1p, 'EXIT rc='), 'rc'),
  gateEmpty: field(find(empty, 'EXIT rc='), 'rc'),
  gateG3: field(find(g3, 'EXIT rc='), 'rc'),
  dshVersion: verdictVersion(),
  domains: field(find(g1p, 'probe storage domains='), 'domains'),
  routeStatus: field(find(g1p, 'probe route http '), 'status'),
  routeContentType: field(find(g1p, 'probe route http '), 'content_type'),
  routeKind: field(find(g1p, 'probe route http '), 'route'),
  routeBytes: field(find(g1p, 'probe route http '), 'bytes'),
  routeMatch: field(find(g1p, 'probe route http '), 'match'),
  emptyDomains: empty.filter((line) => line.startsWith('empty domain=')).length,
  emptyRoute: field(find(empty, 'probe route empty status='), 'status'),
  emptyRouteMissing: field(find(empty, 'probe route empty status='), 'missing'),
  g1pVerdict: verdictOf(g1p, 'G1-P'),
  emptyVerdict: verdictOf(empty, 'G-EMPTY'),
  g3Verdict: verdictOf(g3, 'G3'),
  ownerStorage: field(find(g1p, 'probe owner-storage '), 'untouched'),
  testsTotal: field(find(g3, 'tests total='), 'total'),
  testsSkipped: field(find(g3, 'tests total='), 'skipped'),
  coverage: oneGate(g3, 'COVERAGE'),
  selftest: field(find(g1p, '# gate-check selftest rc='), 'rc'),
  typecheck: oneGate(g3, 'TYPECHECK'),
  syncContracts: oneGate(g3, 'SYNC-CONTRACTS'),
  mirror: oneGate(g3, 'MIRROR'),
  probes: g1p.filter((line) => line.startsWith('probe ')).length,
}

const failures = []
if (facts.gateG1P !== '0') failures.push('G1-P rc')
for (const [key, label] of [['gateG1P', 'G1-P rc'], ['gateEmpty', 'G-EMPTY rc'], ['gateG3', 'G3 rc']]) if (facts[key] !== '0') failures.push(label)
if (facts.gateEmpty !== '0') failures.push('G-EMPTY rc')
if (facts.gateG3 !== '0') failures.push('G3 rc')
if (facts.domains !== '8') failures.push('domain count')
if (facts.routeStatus !== '200' || facts.routeKind !== 'resource' || facts.routeMatch !== 'yes') failures.push('route answer')
if (facts.emptyDomains !== 6 || facts.emptyRouteMissing !== '6') failures.push('empty state')
if (facts.ownerStorage !== 'yes') failures.push('owner storage untouched')
if (Number(facts.testsTotal) < 571 || facts.testsSkipped !== '0') failures.push('tests')
for (const [key, value] of [['typecheck', 'PASS'], ['syncContracts', 'PASS'], ['mirror', 'PASS']]) if (facts[key] !== value) failures.push(key)
if (facts.coverage !== 'PASS') failures.push('coverage')
if (facts.selftest !== '0') failures.push('gate-check selftest rc')
if (facts.dshVersion !== '0.2.2-rc.1') failures.push('dsh version')
if (facts.selftest !== '0') failures.push('gate-check selftest line missing')
if (facts.emptyRoute !== '200' || facts.emptyRouteMissing !== '6') failures.push('empty route answer')
for (const [key, gate] of [['g1pVerdict', 'G1-P'], ['emptyVerdict', 'G-EMPTY'], ['g3Verdict', 'G3']]) if (facts[key] !== 'PASS') failures.push(gate + ' verdict')

const document = {
  generated_at: new Date().toISOString(),
  facts,
  logs: Object.fromEntries(Object.entries(LOGS).map(([name, path]) => [name, { path, sha256: sha256(readFileSync(path, 'utf8')) }])),
  verdict: failures.length === 0 ? 'PASS' : 'FAIL',
  failures,
}
// every structural and value check has run above; only now the document is built
writeFileSync(resolve(handoff, 'p7-evidence.json'), `${JSON.stringify(document, null, 2)}\n`)

for (const [key, value] of Object.entries(facts)) console.log(`${key}=${value}`)
console.log(`EVIDENCE ${document.verdict}${document.verdict === 'PASS' ? '' : ` (${document.failures.join(', ')})`}`)
console.log(`logs sha256 g1p=${document.logs.g1p.sha256.slice(0, 16)} empty=${document.logs.empty.sha256.slice(0, 16)} g3=${document.logs.g3.sha256.slice(0, 16)}`)
process.exit(document.verdict === 'PASS' ? 0 : 1)
