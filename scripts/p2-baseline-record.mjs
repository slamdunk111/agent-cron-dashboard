#!/usr/bin/env node
/**
 * Turn a vitest run log into the structured baseline G3 compares against.
 *
 * Plan §8 pen 0: run the suite on the committed baseline commit, keep the raw
 * log (`p1-test-log.txt`) and record a four-line baseline
 * (`p1-test-count.txt`): skip / passed / commit / log sha256. The gate
 * (`p2-gate-check.mjs --gate G3`) reads these keys, so neither side may invent
 * a format; the raw log stays the evidence a human can re-read.
 *
 * Usage:
 *   node scripts/p2-baseline-record.mjs --log <vitest.log> --out <baseline.txt> [--commit <sha>]
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** Parse vitest's summary line; supports `Tests  N passed (N)` and `... | S skipped`. */
export function parseSummary(text) {
  // Strip ANSI colour codes so the summary parses the same in a TTY log.
  const plain = text.replace(/\u001b\[[0-9;]*m/g, '')
  const line = plain
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => /^Tests\s+\d+\s+(passed|failed)/.test(entry))
  if (line === undefined) return undefined
  const passed = Number(/(\d+)\s+passed/.exec(line)?.[1] ?? '0')
  const failed = Number(/(\d+)\s+failed/.exec(line)?.[1] ?? '0')
  const skipped = Number(/(\d+)\s+skipped/.exec(line)?.[1] ?? '0')
  return { line, passed, failed, skipped }
}

/**
 * Build the baseline body from a log.
 * @param logText - raw vitest stdout/stderr.
 * @param sha - SHA-256 of the raw log, written verbatim.
 * @param commit - commit the run happened on.
 * @returns the four-line baseline, or throws when the summary is missing.
 */
export function baselineBody(logText, sha, commit) {
  const summary = parseSummary(logText)
  if (summary === undefined) throw new Error('no vitest summary line found in the log')
  return `skip=${summary.skipped}\npassed=${summary.passed}\ncommit=${commit}\nlog_sha256=${sha}\n`
}

/** Read `--flag value` pairs without a dependency. */
function argOf(argv, name, fallback) {
  const index = argv.indexOf(name)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}

function main(argv) {
  const logPath = argOf(argv, '--log', undefined)
  const outPath = argOf(argv, '--out', undefined)
  if (logPath === undefined || outPath === undefined) {
    console.error('usage: node scripts/p2-baseline-record.mjs --log <vitest.log> --out <baseline.txt> [--commit <sha>]')
    return 2
  }
  const logText = readFileSync(resolve(logPath), 'utf8')
  const sha = createHash('sha256').update(logText).digest('hex')
  const commit = argOf(argv, '--commit', undefined) ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const body = baselineBody(logText, sha, commit)
  writeFileSync(resolve(outPath), body)
  console.log(`baseline written: ${outPath}`)
  console.log(body.trim())
  return 0
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('p2-baseline-record.mjs')) process.exit(main(process.argv.slice(2)))
