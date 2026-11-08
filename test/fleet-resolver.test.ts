import { describe, expect, it } from 'vitest'
import type { ChangeEvent } from '../contracts/events.ts'
import type { ErrorEntry } from '../contracts/fleet-source.ts'
import type { FingerprintRecord, FleetJobRecord, IssueRecord } from '../contracts/records.ts'
import { ErrorPipeline, type PipelineTables } from '../packages/agent-cron-dashboard/src/fleet/error-pipeline.ts'
import { ErrorResolver, RESOLVE_ACTIONS, stateBadge } from '../packages/agent-cron-dashboard/src/fleet/resolver.ts'

function memory(): { tables: PipelineTables; events: Map<string, ChangeEvent> } {
  const errors = new Map<string, IssueRecord>()
  const fingerprints = new Map<string, FingerprintRecord>()
  const jobs = new Map<string, FleetJobRecord>()
  const events = new Map<string, ChangeEvent>()
  const table = <T>(store: Map<string, T>) => ({
    get: (key: string) => store.get(key),
    put: async (key: string, value: T) => void store.set(key, value),
    keys: () => [...store.keys()],
    delete: async (key: string) => store.delete(key),
  })
  return { events, tables: { errors: table(errors), fingerprints: table(fingerprints), jobs: table(jobs), events: table(events) } }
}

const LINE = 'Todo modify tool invocation failed'
const ENTRY = (occurredAt: string): ErrorEntry => ({ sourceId: 'jiuwen-gmk', jobId: 'cron-todo', occurredAt, severity: 'error', message: LINE, raw: 'fixture' })
const CLOCK = () => new Date('2026-11-09T09:00:00.000+08:00')

async function ledgerRecord(state: IssueRecord['state']): Promise<{ resolver: ErrorResolver; pipeline: ErrorPipeline; id: string }> {
  const store = memory()
  const pipeline = new ErrorPipeline({ tables: store.tables, greenRunsToVerify: 3, retentionDays: 90, now: CLOCK })
  await pipeline.ingest([ENTRY('2026-11-06T15:07:35+08:00')], { autoAnalyze: false })
  const record = pipeline.records()[0]!
  await pipeline.save({ ...record, state })
  return { resolver: new ErrorResolver({ pipeline, now: CLOCK }), pipeline, id: record.recordId }
}

describe('resolver: the three write actions and their illegal edges', () => {
  it('lists the same three actions the step kinds carry', () => {
    expect([...RESOLVE_ACTIONS]).toEqual(['fix-applied', 'wontfix', 'reopen'])
  })

  it('registers a repair on an analyzed record and names the waiting rule', async () => {
    const { resolver, id } = await ledgerRecord('analyzed')
    const outcome = await resolver.resolve({ recordId: id, action: 'fix-applied', note: 'raised the todo timeout' })
    expect(outcome.ok).toBe(true)
    expect(outcome.record?.state).toBe('fix-applied')
    expect(outcome.record?.resolution.at(-1)).toEqual({ kind: 'fix-applied', at: new Date('2026-11-09T09:00:00.000+08:00').toISOString(), by: 'tool', note: 'raised the todo timeout' })
    expect(outcome.text).toContain('waiting for 3 consecutive green runs of jiuwen-gmk/cron-todo')
  })

  it('rejects a repair on an open record with a readable reason and writes nothing', async () => {
    const { resolver, pipeline, id } = await ledgerRecord('open')
    const before = pipeline.record(id)!
    const outcome = await resolver.resolve({ recordId: id, action: 'fix-applied' })
    expect(outcome.ok).toBe(false)
    expect(outcome.text).toContain('rejected: illegal IssueRecord transition open -> fix-applied')
    expect(pipeline.record(id)).toEqual(before)
  })

  it('dismisses with wontfix and reopens it again with an event', async () => {
    const { resolver, pipeline, id } = await ledgerRecord('analyzed')
    const dismissed = await resolver.resolve({ recordId: id, action: 'wontfix', note: 'by design' })
    expect(dismissed.ok).toBe(true)
    expect(dismissed.record?.state).toBe('closed-wontfix')
    const reopened = await resolver.resolve({ recordId: id, action: 'reopen', by: 'agent' })
    expect(reopened.ok).toBe(true)
    expect(reopened.subjectKey).toBe(`error/${id}`)
    expect(pipeline.record(id)!.resolution.at(-1)).toMatchObject({ kind: 'reopened', by: 'agent' })
  })

  it('reopens a verified record and brings it back for analysis', async () => {
    const { resolver, id, pipeline } = await ledgerRecord('verified-resolved')
    const outcome = await resolver.resolve({ recordId: id, action: 'reopen' })
    expect(pipeline.record(id)!.state).toBe('reopened')
    expect(outcome.record?.state).toBe('reopened')
  })

  it('refuses a second repair while the first one is still under verification', async () => {
    const { resolver, id } = await ledgerRecord('fix-applied')
    const outcome = await resolver.resolve({ recordId: id, action: 'fix-applied' })
    expect(outcome.ok).toBe(false)
  })

  it('names an unknown record instead of throwing', async () => {
    const { resolver } = await ledgerRecord('open')
    const outcome = await resolver.resolve({ recordId: 'jiuwen-gmk-does-not-exist', action: 'wontfix' })
    expect(outcome).toEqual({ ok: false, text: 'record not found: jiuwen-gmk-does-not-exist', subjectKey: null, record: null })
  })

  it('keeps the recurrence count across a dismiss and reopen', async () => {
    const { resolver, pipeline, id } = await ledgerRecord('analyzed')
    await resolver.resolve({ recordId: id, action: 'wontfix' })
    await resolver.resolve({ recordId: id, action: 'reopen' })
    expect(pipeline.record(id)!.count).toBe(1)
    expect(pipeline.record(id)!.state).toBe('reopened')
  })

  it('badges a verified record with its own state name', async () => {
    const { pipeline, id } = await ledgerRecord('verified-resolved')
    expect(stateBadge(pipeline.record(id)!)).toBe('verified-resolved')
  })
})
