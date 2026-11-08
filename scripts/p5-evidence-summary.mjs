#!/usr/bin/env node
/**
 * P5 evidence summary: every number the report quotes is produced here from the
 * fixed gate logs, the plan and the manifest files — nothing is transcribed by
 * hand (十六次号令闸门 1「数字机器生成」).
 *
 * Usage:
 *   node scripts/p5-evidence-summary.mjs [--out ../docs/handoff/p5-evidence.json]
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const argv = process.argv.slice(2)
const outIndex = argv.indexOf('--out')
const outPath = resolve(outIndex >= 0 && argv[outIndex + 1] !== undefined ? argv[outIndex + 1] : resolve(ROOT, '../docs/handoff/p5-evidence.json'))

/** Read a file or return an empty string when it does not exist yet. */
function readOrEmpty(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/** SHA256 of one file (or '' when missing). */
function sha256(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return ''
  }
}

/** mtime in +08:00. */
function mtime(path) {
  try {
    const d = new Date(statSync(path).mtimeMs)
    return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().replace('Z', '+08:00')
  } catch {
    return ''
  }
}

/** Every match of one regex across a text, keyed. */
function collect(text, re) {
  return [...text.matchAll(re)].map((match) => match.slice(1))
}

const g1 = readOrEmpty(resolve(ROOT, '../docs/handoff/p5-g1.log'))
const g3 = readOrEmpty(resolve(ROOT, '../docs/handoff/p5-g3.log'))
const base = readOrEmpty(resolve(ROOT, '../docs/handoff/p5-g3-base.log'))
const plan = resolve(ROOT, '.omo/plans/p5-fleet-adapters.md')
const mirror = resolve(ROOT, '../docs/handoff/P5-实施计划.md')
const baseline = resolve(ROOT, '../docs/handoff/p5-baseline.txt')

const numbers = {
  generated_at: new Date().toISOString(),
  generated_at_offset: '+08:00',
  g1: {
    log: resolve(ROOT, '../docs/handoff/p5-g1.log'),
    sha256: sha256(resolve(ROOT, '../docs/handoff/p5-g1.log')),
    mtime: mtime(resolve(ROOT, '../docs/handoff/p5-g1.log')),
    exit_rc: /EXIT rc=(\d+)/.exec(g1)?.[1] ?? '',
    gate_line: (g1.split('\n').find((line) => line.startsWith('GATE G1')) ?? ''),
    env: (g1.split('\n').find((line) => line.startsWith('env ')) ?? ''),
    env_state: (g1.split('\n').find((line) => line.startsWith('env_state ')) ?? ''),
    replays: collect(g1, /replay source=(\S+) jobs=(\d+) runs=(\d+) errors=(\d+)/g).map(([id, jobs, runs, errors]) => ({ id, jobs, runs, errors })),
    replay_numbers: (g1.split('\n').find((line) => line.startsWith('replay numbers') ) ?? ''),
    replay_events: collect(g1, /replay_event kind=([a-z-]+) key=(\S+) level=([a-z]+)/g).map(([kind, key, level]) => ({ kind, key, level })),
    nas: collect(g1, /nas round=(\d+) rc=(\d+) jobs=(\d+) runs=(\d+) script_error=(\d+) cursor=(\d+) errors=(\d+) at=(\S+)/g).map(([round, rc, jobs, runs, scriptErrors, cursor, errors, at]) => ({ round, rc, jobs, runs, script_errors: scriptErrors, cursor, errors, at })),
    gmk: collect(g1, /gmk round=(\d+) rc=(\d+) health=(\w+) jobs=(\d+) runs=(\d+) errors=(\d+) at=(\S+)/g).map(([round, rc, health, jobs, runs, errors, at]) => ({ round, rc, health, jobs, runs, errors, at })),
    bad: collect(g1, /bad round=(\d+) health=(\w+) failures=(\d+) backoff=(\d+) at=(\S+)/g).map(([round, health, failures, backoff, at]) => ({ round, health, failures, backoff, at })),
    status: (g1.split('\n').find((line) => line.startsWith('status scope=')) ?? ''),
  },
  g3: {
    log: resolve(ROOT, '../docs/handoff/p5-g3.log'),
    sha256: sha256(resolve(ROOT, '../docs/handoff/p5-g3.log')),
    mtime: mtime(resolve(ROOT, '../docs/handoff/p5-g3.log')),
    exit_rc: /EXIT rc=(\d+)/.exec(g3)?.[1] ?? '',
    gate_line: (g3.split('\n').find((line) => line.startsWith('GATE G3')) ?? ''),
    total: Number(/TOTAL\s+(\d+)/.exec(g3)?.[1] ?? 0),
    tests_passed: /Tests\s+(\d+) passed \((\d+)\)/.exec(g3)?.[1] ?? '',
    skipped: Number(/(\d+) skipped/.exec(g3)?.[1] ?? 0),
    coverage_pass: g3.includes('COVERAGE-GATE PASS'),
    mirror_pass: g3.includes('MIRROR PASS'),
    typecheck_pass: g3.includes('TYPECHECK PASS'),
    sync_pass: g3.includes('SYNC-CONTRACTS PASS'),
    verdicts: g3.split('\n').filter((line) => line.startsWith('PASS ') || line.startsWith('FAIL ') || line.startsWith('GATE G3')).slice(-40),
  },
  baseline: {
    file: baseline,
    text: base.split('\n').find((line) => line.startsWith('skip=')) ?? '',
    recorded: readOrEmpty(baseline).trim(),
  },
  plan: {
    canonical: plan,
    sha256: sha256(plan),
    mirror,
    mirror_sha256: sha256(mirror),
  },
  commits: readOrEmpty(resolve(ROOT, '../docs/handoff/p5-commits.txt')).trim(),
}

writeFileSync(outPath, `${JSON.stringify(numbers, null, 1)}\n`)
console.log(`wrote ${outPath}`)
console.log(`G1 ${numbers.g1.gate_line} exit=${numbers.g1.exit_rc} | G3 TOTAL=${String(numbers.g3.total)} ${numbers.g3.gate_line}`)
for (const row of numbers.g1.nas) console.log(`nas round=${row.round} runs=${row.runs} script_error=${row.script_errors} cursor=${row.cursor} errors=${row.errors} at=${row.at}`)
for (const row of numbers.g1.gmk) console.log(`gmk round=${row.round} health=${row.health} jobs=${row.jobs} runs=${row.runs} at=${row.at}`)
