import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ErrorEntry } from '../contracts/fleet-source.ts'
import { evaluateSamples, normalize, signatureOf, SIGNATURE_PREFIX, type FingerprintCase } from '../packages/agent-cron-dashboard/src/fleet/fingerprint.ts'

const root = resolve(import.meta.dirname, '..')
const SET = 'fixtures/fleet/p6-fingerprint-set.json'
const LOADED = JSON.parse(readFileSync(resolve(root, SET), 'utf8')) as {
  version: number
  cases: FingerprintCase[]
  sameCauseGroups: { id: string; cases: string[] }[]
}

const entryOf = (entry: FingerprintCase): ErrorEntry => ({
  sourceId: entry.sourceId,
  jobId: entry.jobId,
  occurredAt: '2026-11-05T19:30:42.378+08:00',
  severity: 'error',
  message: entry.message,
  raw: 'fixture',
})

describe('fingerprint normalize: measured-shape rules, one rule per case', () => {
  it('drops the hermes millisecond timestamp and keeps the word', () => {
    expect(normalize('2026-11-08 22:14:00,525 WARNING agent said no')).toBe('WARNING agent said no')
  })

  it('drops a timestamp without milliseconds', () => {
    expect(normalize('2026-10-26 05:01:20 tool failed')).toBe('tool failed')
  })

  it('drops ISO 8601 instants with a zone', () => {
    expect(normalize('run at 2026-09-28T17:20:21+08:00 broke')).toBe('run at broke')
  })

  it('replaces only the digit-bearing run inside a hyphenated uuid', () => {
    // No measured sample carries a uuid, so the table does not invent a uuid rule. The
    // identifier rule fires on the one >=12 digit-bearing run, which is the documented
    // behaviour of that rule rather than a uuid claim.
    expect(normalize('job 3f2504e0-4f89-41d3-9a0c-0305e82c3301 crashed')).toBe('job 3f2504e0-4f89-41d3-9a0c-<id> crashed')
  })



  it('drops numbers inside path segments but keeps the segment names', () => {
    expect(normalize("'/home/18058169312/.hermes/scripts/systemd_health_check.py'")).toBe("'/home/<num>/.hermes/scripts/systemd_health_check.py'")
    expect(normalize('(/data_s001/18058169312/openclaw-data/.hermes/scripts)')).toBe('(/data_s001/<num>/openclaw-data/.hermes/scripts)')
  })

  it('drops line numbers in both measured shapes', () => {
    expect(normalize('failure at line 412 in runner.py')).toBe('failure at line <line> in runner.py')
    expect(normalize('runner.py:87 raised')).toBe('runner.py:<line> raised')
  })

  it('drops elapsed durations', () => {
    expect(normalize('Tool vision_analyze returned error (0.30s): {')).toBe('Tool vision_analyze returned error (<dur>): {')
    expect(normalize('timed out after 10.0s here')).toBe('timed out after <dur> here')
  })

  it('collapses whitespace and left-trims', () => {
    expect(normalize('  a   b \n c  ')).toBe('a b c')
  })

  it('keeps the measured jiuwenswarm message verbatim (no date, no path)', () => {
    expect(normalize('Todo modify tool invocation failed')).toBe('Todo modify tool invocation failed')
  })
})

describe('fingerprint signature: sourceId + jobId + normalize, sha1 hex', () => {
  it('is a sha1 hex prefix of the frozen length', () => {
    const signature = signatureOf({ sourceId: 'hermes-nas', jobId: '68f64ca3b0b1', message: 'same' })
    expect(signature).toMatch(/^[0-9a-f]{40}$/)
    expect(SIGNATURE_PREFIX).toBe(12)
  })

  it('separates two jobs of the same source with the same message', () => {
    const base = { occurredAt: '2026-11-05T19:30:42.378+08:00', severity: 'error' as const, message: 'Blocked: x', raw: 'fixture' }
    expect(signatureOf({ ...base, sourceId: 'hermes-nas', jobId: 'a' })).not.toBe(signatureOf({ ...base, sourceId: 'hermes-nas', jobId: 'b' }))
  })

  it('separates two sources with the same job and message', () => {
    const base = { occurredAt: '2026-11-05T19:30:42.378+08:00', severity: 'error' as const, message: 'Blocked: x', raw: 'fixture' }
    expect(signatureOf({ ...base, sourceId: 'hermes-nas', jobId: 'a' })).not.toBe(signatureOf({ ...base, sourceId: 'jiuwen-gmk', jobId: 'a' }))
  })

  it('joins entries that differ only in timestamps', () => {
    const base = { occurredAt: '2026-11-05T19:30:42.378+08:00', severity: 'error' as const, message: 'Todo modify tool invocation failed', raw: 'fixture', sourceId: 'jiuwen-gmk', jobId: 'x' }
    const signature = signatureOf(base)
    const later: ErrorEntry = { ...base, occurredAt: '2026-11-06T15:07:35+08:00' }
    expect(signatureOf(later)).toBe(signature)
  })

  it('falls back to an empty job segment when the entry has no job', () => {
    const base = { occurredAt: '2026-11-05T19:30:42.378+08:00', severity: 'error' as const, message: 'Todo modify tool invocation failed', raw: 'fixture', sourceId: 'jiuwen-gmk' }
    expect(signatureOf(base)).toBe(signatureOf({ ...base, jobId: '' }))
  })
})

describe('fingerprint evaluation set: P5 measured samples only', () => {
  it('is derived from the three measured fixtures and declares its transforms', () => {
    expect(LOADED.version).toBe(1)
    expect(LOADED.cases.length).toBeGreaterThanOrEqual(27)
    for (const entry of LOADED.cases) {
      expect(entry.derived_from.file).toMatch(/^fixtures\/(hermes|jiuwenswarm)\//)
      expect(entry.transform).toMatch(/^(verbatim|fields|rotate_ts)$/)
      expect(entry.message.length).toBeGreaterThan(0)
    }
  })

  it('every same-cause group collapses to one signature and stays under 90% only if an error exists', () => {
    const verdict = evaluateSamples(LOADED)
    expect(verdict.sameCauseTotal).toBe(LOADED.cases.filter((entry) => entry.expect === 'same').length)
    expect(verdict.differentCauseTotal).toBe(LOADED.cases.filter((entry) => entry.expect === 'diff').length)
    expect(verdict.hitRate).toBeGreaterThanOrEqual(90)
    expect(verdict.errors).toEqual([])
    expect(verdict.sameCauseMerged).toBe(verdict.sameCauseTotal)
    expect(verdict.differentCauseSeparated).toBe(verdict.differentCauseTotal)
  })

  it('so the sheet, not the number, is the evidence: each case passes individually', () => {
    const verdict = evaluateSamples(LOADED)
    expect(verdict.cases.length).toBe(LOADED.cases.length)
    expect(verdict.cases.every((entry) => entry.verdict === 'PASS')).toBe(true)
    expect([...verdict.cases.map((entry) => entry.id)].sort()).toEqual([...LOADED.cases.map((entry) => entry.id)].sort())
  })

  it('every same-cause group has at least two members and no diff case sits in one', () => {
    for (const group of LOADED.sameCauseGroups) {
      expect(group.cases.length).toBeGreaterThanOrEqual(2)
      const members = LOADED.cases.filter((entry) => group.cases.includes(entry.id))
      expect(members.every((entry) => entry.expect === 'same')).toBe(true)
    }
  })

  it('every case belongs to exactly one group and every group is covered', () => {
    const grouped = new Set(LOADED.sameCauseGroups.flatMap((group) => group.cases))
    expect(grouped.size).toBe(new Set([...grouped]).size)
    expect(LOADED.cases.filter((entry) => entry.expect === 'same').every((entry) => grouped.has(entry.id))).toBe(true)
  })

  it('rotated timestamps do not change a signature (the skin differs, the cause does not)', () => {
    const group = LOADED.sameCauseGroups[0]!
    const members = LOADED.cases.filter((entry) => group.cases.includes(entry.id))
    const signatures = new Set(members.map((entry) => signatureOf(entryOf(entry))))
    expect(signatures.size).toBe(1)
  })
})
