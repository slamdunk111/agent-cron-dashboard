import { describe, expect, it } from 'vitest'
import { CHANGE_LEVELS } from '../contracts/events.ts'
import type { FleetJob, FleetRun } from '../contracts/fleet-source.ts'
import type { SourceHealth as RecordedHealth } from '../contracts/records.ts'
import { gradeHealth, gradeRun, runKey, healthKey, P5_EMITTABLE_KINDS, P6_RESERVED_KINDS, type FleetGraded } from '../packages/agent-cron-dashboard/src/fleet/grade-fleet.ts'

const health = (state: RecordedHealth['state']): RecordedHealth => ({ sourceId: 'hermes-nas', state, latencyMs: 12, checkedAt: '2026-11-08T23:40:00.000+08:00', message: null, consecutiveFailures: 0 })

/** Results of one grading step, in a shape the assertions can read. */
function kinds(graded: FleetGraded[]): string[] {
  return graded.map((entry) => entry.kind)
}

describe('fleet grading (P5: four keys only)', () => {
  it('maps a run from ok to failed as run-failed and from failed to ok as run-recovered', () => {
    expect(kinds(gradeRun('ok', 'failed', 'job-1'))).toEqual(['run-failed'])
    expect(kinds(gradeRun('failed', 'ok', 'job-1'))).toEqual(['run-recovered'])
  })

  it('produces nothing on a first observation or on an unchanged status', () => {
    expect(kinds(gradeRun(null, 'failed', 'job-1'))).toEqual([])
    expect(kinds(gradeRun('failed', 'failed', 'job-1'))).toEqual([])
    expect(kinds(gradeRun('ok', 'ok', 'job-1'))).toEqual([])
    expect(kinds(gradeRun('running', 'ok', 'job-1'))).toEqual([])
  })

  it('maps a health transition both ways and never for disabled', () => {
    expect(kinds(gradeHealth(health('up'), health('down')))).toEqual(['source-health-down'])
    expect(kinds(gradeHealth(health('down'), health('up')))).toEqual(['source-health-recovered'])
    expect(kinds(gradeHealth(health('up'), health('disabled')))).toEqual([])
    expect(kinds(gradeHealth(null, health('down')))).toEqual([])
    expect(kinds(gradeHealth(health('degraded'), health('up')))).toEqual(['source-health-recovered'])
    expect(kinds(gradeHealth(health('up'), health('degraded')))).toEqual([])
  })

  it('reads the levels from the frozen table instead of a local copy', () => {
    const graded = gradeRun('ok', 'failed', 'job-1')
    expect(graded[0]?.level).toBe(CHANGE_LEVELS['run-failed'])
    const recovered = gradeHealth(health('down'), health('up'))
    expect(recovered[0]?.level).toBe(CHANGE_LEVELS['source-health-recovered'])
    expect(gradeRun('ok', 'failed', 'job-1')[0]?.evidence.length).toBeGreaterThan(0)
  })

  it('keeps the error-record keys reserved for P6 (P5 never emits them)', () => {
    // derived from the frozen table: the three error-record keys and nothing else
    expect([...P6_RESERVED_KINDS].sort()).toEqual(['error-record-opened', 'error-record-reopened', 'error-record-verified'])
    expect(P6_RESERVED_KINDS.every((kind) => CHANGE_LEVELS[kind] !== undefined)).toBe(true)
    for (const kind of P5_EMITTABLE_KINDS) {
      expect(P6_RESERVED_KINDS).not.toContain(kind)
      expect(CHANGE_LEVELS[kind]).toBeTruthy()
    }
  })

  it('names the subject keys the way the storage layout does', () => {
    const run: FleetRun = { jobId: '68f64ca3b0b1', startedAt: '2026-09-28T17:20:21+08:00', status: 'failed' }
    const job: FleetJob = { id: '68f64ca3b0b1', name: 'patrol', schedule: null, script: null, lastRunAt: null, lastStatus: null }
    expect(runKey('hermes-nas', run)).toBe('hermes-nas/68f64ca3b0b1')
    expect(runKey('hermes-nas', run, job)).toBe('hermes-nas/68f64ca3b0b1')
    expect(healthKey('hermes-nas')).toBe('hermes-nas')
  })
})
