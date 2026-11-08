import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ChangeEvent } from '../contracts/events.ts'
import type { ErrorEntry } from '../contracts/fleet-source.ts'
import type { FingerprintRecord, FleetJobRecord, IssueRecord } from '../contracts/records.ts'
import { ErrorAnalyzer, type AnalysisChunk, type AnalysisPort, type AnalysisRequest } from '../packages/agent-cron-dashboard/src/fleet/analyzer.ts'
import { detailTextOf } from '../packages/agent-cron-dashboard/src/fleet/analyzer.ts'
import { ErrorPipeline, pullRunEventErrors, SAMPLE_RING, type PipelineTables } from '../packages/agent-cron-dashboard/src/fleet/error-pipeline.ts'
import { decodeEventKey, eventKeyOf, ESCAPE_TABLES } from '../packages/agent-cron-dashboard/src/fleet/event-key.ts'

const root = resolve(import.meta.dirname, '..')

/** Four-table memory store (read/write counters keep the assertions honest). */
type TestTables = PipelineTables & { jobs: PipelineTables['jobs'] & { put(key: string, value: FleetJobRecord): Promise<void> } }

function memoryTables(): { tables: TestTables; events: Map<string, ChangeEvent>; writes: { errors: number; fingerprints: number; events: number } } {
  const errors = new Map<string, IssueRecord>()
  const fingerprints = new Map<string, FingerprintRecord>()
  const jobs = new Map<string, FleetJobRecord>()
  const events = new Map<string, ChangeEvent>()
  const writes = { errors: 0, fingerprints: 0, events: 0 }
  const table = <T>(store: Map<string, T>, counter?: keyof typeof writes) => ({
    get: (key: string) => store.get(key),
    put: async (key: string, value: T) => {
      if (counter !== undefined) writes[counter] += 1
      store.set(key, value)
    },
    keys: () => [...store.keys()],
    delete: async (key: string) => store.delete(key),
  })
  return {
    writes,
    events,
    tables: {
      errors: table(errors, 'errors'),
      fingerprints: table(fingerprints, 'fingerprints'),
      jobs: table(jobs),
      events: table(events, 'events') as TestTables['events'],
    },
  }
}

/** One measured hermes errors.log line, twice with different instants (same cause). */
const LINE_A = "Error analyzing image: Error code: 400 - {'error': {'message': 'this server does not accept images: the engine was started without a vision tower (HALOGEN_VISION_TOWER)'}}"
const entryAt = (occurredAt: string, message = LINE_A, jobId = 'tools.vision_tools'): ErrorEntry => ({ sourceId: 'hermes-nas', jobId, occurredAt, severity: 'error', message, raw: 'fixture' })

/** Scripted analysis: first call valid, later calls fail (keeps the pump deterministic). */
function scriptedAnalyzer(scripts: readonly (readonly AnalysisChunk[] | string)[]): { analyzer: ErrorAnalyzer; calls: AnalysisRequest[] } {
  const calls: AnalysisRequest[] = []
  let index = 0
  const port: AnalysisPort = {
    provider: 'fake',
    model: 'fake-1',
    async *stream(request: AnalysisRequest): AsyncIterable<AnalysisChunk> {
      calls.push(request)
      const script = scripts[Math.min(index, scripts.length - 1)]!
      index += 1
      if (typeof script === 'string') {
        yield { type: 'text-delta', text: script }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      for (const chunk of script) yield chunk
    },
  }
  return { analyzer: new ErrorAnalyzer({ port }), calls }
}

const VALID = JSON.stringify({ rootCauseHypothesis: 'vision tower absent', impact: 'image analysis fails', suggestedFix: ['start the engine with HALOGEN_VISION_TOWER'], confidence: 0.8, needMoreInfo: [] })

/** A fixed clock so every emitted key and instant is reproducible. */
function fixedClock(iso = '2026-11-09T08:00:00.000+08:00'): { now: () => Date; advance: (ms: number) => void } {
  let current = Date.parse(iso)
  return { now: () => new Date(current), advance: (ms: number) => { current += ms } }
}

describe('ErrorPipeline.ingest: open, dedupe, ring, reopen', () => {
  it('opens one record for the first observation and emits a high event', async () => {
    const store = memoryTables()
    const clock = fixedClock()
    const pipeline = new ErrorPipeline({ tables: store.tables, greenRunsToVerify: 3, retentionDays: 90, now: clock.now })
    const outcome = await pipeline.ingest([entryAt('2026-11-07T16:03:18.272+08:00')], { autoAnalyze: false })
    expect(outcome.opened).toBe(1)
    expect(outcome.revisited).toBe(0)
    const record = pipeline.records()[0]!
    expect(record.state).toBe('open')
    expect(record.count).toBe(1)
    expect(record.recordId.startsWith('hermes-nas-')).toBe(true)
    expect(record.samples).toHaveLength(1)
    const event = [...store.events.values()][0]!
    expect(event.kind).toBe('error-record-opened')
    expect(event.level).toBe('high')
    expect(event.subject.key).toBe(`error/${record.recordId}`)
    expect(event.evidence.every((item) => item.field !== '')).toBe(true)
  })

  it('counts a repeat of the same cause and refreshes lastSeen without a second row', async () => {
    const store = memoryTables()
    const pipeline = new ErrorPipeline({ tables: store.tables, greenRunsToVerify: 3, retentionDays: 90 })
    await pipeline.ingest([entryAt('2026-11-07T16:03:18.272+08:00')], { autoAnalyze: false })
    const second = await pipeline.ingest([entryAt('2026-11-08T12:49:37.194+08:00')], { autoAnalyze: false })
    expect(second.opened).toBe(0)
    expect(second.revisited).toBe(1)
    const record = pipeline.records()[0]!
    expect(record.count).toBe(2)
    expect(record.lastSeen).toBe('2026-11-08T12:49:37.194+08:00')
    expect(pipeline.records()).toHaveLength(1)
    expect([...store.events.values()].filter((event) => event.kind === 'error-record-opened')).toHaveLength(1)
  })

  it('keeps the newest five samples in the ring', async () => {
    const store = memoryTables()
    const pipeline = new ErrorPipeline({ tables: store.tables, greenRunsToVerify: 3, retentionDays: 90 })
    const instants = ['01', '02', '03', '04', '05', '06', '07'].map((hour) => `2026-11-0${String(Number(hour) <= 7 ? 8 : 9)}T${hour}:00:00+08:00`)
    for (const instant of instants) await pipeline.ingest([entryAt(instant)], { autoAnalyze: false })
    const record = pipeline.records()[0]!
    expect(record.samples).toHaveLength(SAMPLE_RING)
    expect(record.samples.at(-1)?.occurredAt).toBe('2026-11-08T07:00:00+08:00')
  })

  it('masks the stored sample before it reaches the ledger', async () => {
    const store = memoryTables()
    const pipeline = new ErrorPipeline({ tables: store.tables, greenRunsToVerify: 3, retentionDays: 90 })
    await pipeline.ingest([entryAt('2026-11-07T16:03:18.272+08:00', 'token=abcdef123456 expired')], { autoAnalyze: false })
    expect(pipeline.records()[0]!.samples[0]!.message).not.toContain('abcdef123456')
  })

  it('reopens a verified record on recurrence, keeps the count and emits the high event', async () => {
    const store = memoryTables()
    const clock = fixedClock()
    const job = (greenStreak: number): FleetJobRecord => ({ sourceId: 'hermes-nas', jobId: 'tools.vision_tools', name: 'vision', schedule: null, script: null, lastRunAt: '2026-11-08T00:00:00+08:00', lastStatus: greenStreak > 0 ? 'ok' : 'failed', greenStreak, collectedAt: '2026-11-09T00:00:00+08:00' })
    await store.tables.jobs.put('hermes-nas/tools.vision_tools', job(0))
    const pipeline = new ErrorPipeline({ tables: store.tables, greenRunsToVerify: 3, retentionDays: 90, now: clock.now })
    await pipeline.ingest([entryAt('2026-11-07T16:03:18.272+08:00')], { autoAnalyze: false })
    const record = pipeline.records()[0]!
    await pipeline.save({ ...record, state: 'fix-applied' })
    expect(await pipeline.verify('2026-11-09T08:00:00+08:00')).toEqual([])
    await store.tables.jobs.put('hermes-nas/tools.vision_tools', job(5))
    await pipeline.verify('2026-11-09T09:00:00+08:00')
    const verified = pipeline.records()[0]!
    expect(verified.state).toBe('verified-resolved')
    clock.advance(86_400_000)
    const recurrence = await pipeline.ingest([entryAt('2026-11-10T10:00:00+08:00')], { autoAnalyze: false })
    expect(recurrence.reopened).toBe(1)
    const reopened = pipeline.records()[0]!
    expect(reopened.state).toBe('reopened')
    expect(reopened.count).toBe(2)
    expect(reopened.verifiedAt).toBeNull()
    const kinds = [...store.events.values()].map((event) => event.kind)
    expect(kinds).toContain('error-record-verified')
    expect([...store.events.values()].find((event) => event.kind === 'error-record-reopened')!.level).toBe('high')
  })

  it('does not reopen a record that is merely open or analyzed', async () => {
    const store = memoryTables()
    const pipeline = new ErrorPipeline({ tables: store.tables, greenRunsToVerify: 3, retentionDays: 90 })
    await pipeline.ingest([entryAt('2026-11-07T16:03:18.272+08:00')], { autoAnalyze: false })
    const again = await pipeline.ingest([entryAt('2026-11-08T16:03:18.272+08:00')], { autoAnalyze: false })
    expect(again.reopened).toBe(0)
    expect(pipeline.records()[0]!.state).toBe('open')
  })

  it('skips an empty message instead of opening a blank row', async () => {
    const store = memoryTables()
    const pipeline = new ErrorPipeline({ tables: store.tables, greenRunsToVerify: 3, retentionDays: 90 })
    const outcome = await pipeline.ingest([{ ...entryAt('2026-11-07T16:03:18.272+08:00'), message: '   ' }], { autoAnalyze: false })
    expect(outcome.touched).toEqual([])
    expect(pipeline.records()).toHaveLength(0)
  })
})

describe('ErrorPipeline pump: analysis never blocks the ingest', () => {
  it('returns from ingest before the model answers, then lands analyzed', async () => {
    const store = memoryTables()
    let release: () => void = () => undefined
    const gate = new Promise<void>((done) => {
      release = done
    })
    const slowPort = {
      provider: 'fake',
      model: 'fake-slow',
      async *stream() {
        await gate
        yield { type: 'text-delta', text: VALID } as AnalysisChunk
        yield { type: 'finish', reason: { kind: 'stop' } } as AnalysisChunk
      },
    }
    const slow = new ErrorAnalyzer({ port: slowPort })
    const pipeline = new ErrorPipeline({ tables: store.tables, analyzer: slow, greenRunsToVerify: 3, retentionDays: 90 })
    const outcome = await pipeline.ingest([entryAt('2026-11-07T16:03:18.272+08:00')])
    expect(outcome.opened).toBe(1)
    expect(pipeline.records()[0]!.state).toBe('open')
    release()
    const pumped = await pipeline.pump()
    expect(pumped.analyzed).toBe(1)
    expect(pipeline.records()[0]!.state).toBe('analyzed')
    expect(pipeline.records()[0]!.analysis.model).toBe('fake-slow')
    expect(pipeline.pending()).toBe(0)
  })

  it('keeps the row visible as pending when no model is configured', async () => {
    const store = memoryTables()
    const pipeline = new ErrorPipeline({ tables: store.tables, greenRunsToVerify: 3, retentionDays: 90 })
    await pipeline.ingest([entryAt('2026-11-07T16:03:18.272+08:00')], { autoAnalyze: false })
    const pumped = await pipeline.pump()
    expect(pumped.analyzed).toBe(0)
    expect(pumped.pending).toBe(1)
    expect(pipeline.records()[0]!.state).toBe('open')
    expect(pipeline.records()[0]!.analysis.state).toBe('pending')
  })

  it('marks a failed analysis as pending state=failed and keeps the row', async () => {
    const store = memoryTables()
    const failingPort = {
      provider: 'fake',
      model: 'fake-x',
      async *stream(): AsyncIterable<AnalysisChunk> {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH' } } }
      },
    }
    const analyzer = new ErrorAnalyzer({ port: failingPort })
    const pipeline = new ErrorPipeline({ tables: store.tables, analyzer, greenRunsToVerify: 3, retentionDays: 90 })
    await pipeline.ingest([entryAt('2026-11-07T16:03:18.272+08:00')], { autoAnalyze: false })
    const pumped = await pipeline.pump()
    expect(pumped.pending).toBe(1)
    expect(pipeline.records()[0]!.analysis.state).toBe('failed')
    expect(pipeline.records()[0]!.state).toBe('open')
  })

  it('re-analyses a pending record through reanalyze()', async () => {
    const store = memoryTables()
    const fail = { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT' } } } as AnalysisChunk
    const { analyzer } = scriptedAnalyzer([[fail], [fail], VALID])
    const pipeline = new ErrorPipeline({ tables: store.tables, analyzer, greenRunsToVerify: 3, retentionDays: 90 })
    await pipeline.ingest([entryAt('2026-11-07T16:03:18.272+08:00')], { autoAnalyze: false })
    await pipeline.pump()
    const again = await pipeline.reanalyze()
    expect(again.analyzed).toBe(1)
    expect(pipeline.records()[0]!.state).toBe('analyzed')
  })

  it('feeds the analyser prompt with the job record and recent runs', async () => {
    const store = memoryTables()
    const prompts: string[] = []
    const port: AnalysisPort = {
      provider: 'fake',
      model: 'fake-2',
      async *stream(request: AnalysisRequest): AsyncIterable<AnalysisChunk> {
        prompts.push(request.messages[0]!.content)
        yield { type: 'text-delta', text: VALID }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
    const pipeline = new ErrorPipeline({
      tables: store.tables,
      analyzer: new ErrorAnalyzer({ port }),
      greenRunsToVerify: 3,
      retentionDays: 90,
      recentRuns: () => [{ startedAt: '2026-11-08T22:20:07+08:00', status: 'failed' }],
    })
    await pipeline.ingest([entryAt('2026-11-07T16:03:18.272+08:00')], { autoAnalyze: false })
    await pipeline.pump()
    expect(prompts[0]).toContain('JOB SCRIPT: (none)')
    expect(prompts[0]).toContain('- 2026-11-08T22:20:07+08:00 failed')
  })

  it('holds the cached analysis for a repeated signature', async () => {
    const store = memoryTables()
    const { analyzer, calls } = scriptedAnalyzer([VALID])
    const pipeline = new ErrorPipeline({ tables: store.tables, analyzer, greenRunsToVerify: 3, retentionDays: 90 })
    await pipeline.ingest([entryAt('2026-11-07T16:03:18.272+08:00')], { autoAnalyze: false })
    await pipeline.pump()
    await pipeline.ingest([{ ...entryAt('2026-11-08T16:03:18.272+08:00'), jobId: 'other-job' }], { autoAnalyze: false })
    await pipeline.pump()
    expect(calls).toHaveLength(2)
    expect(analyzer.cached(pipeline.records()[0]!.signature, detailTextOf(pipeline.records()[0]!.samples))).not.toBeUndefined()
  })
})

describe('ErrorPipeline.verify: the streak decides, one step only', () => {
  const seed = async (greenStreak: number) => {
    const store = memoryTables()
    const job: FleetJobRecord = { sourceId: 'hermes-nas', jobId: 'tools.vision_tools', name: 'vision', schedule: null, script: null, lastRunAt: null, lastStatus: 'ok', greenStreak, collectedAt: '2026-11-09T00:00:00+08:00' }
    await store.tables.jobs.put('hermes-nas/tools.vision_tools', job)
    const pipeline = new ErrorPipeline({ tables: store.tables, greenRunsToVerify: 3, retentionDays: 90 })
    await pipeline.ingest([entryAt('2026-11-07T16:03:18.272+08:00')], { autoAnalyze: false })
    const record = pipeline.records()[0]!
    await pipeline.save({ ...record, state: 'fix-applied', resolution: [{ kind: 'fix-applied', at: '2026-11-09T07:00:00+08:00', by: 'tool', note: 'restarted with the tower' }] })
    return { store, pipeline }
  }

  it('waits at N-1', async () => {
    const { pipeline } = await seed(2)
    expect(await pipeline.verify('2026-11-09T10:00:00+08:00')).toEqual([])
    expect(pipeline.records()[0]!.state).toBe('fix-applied')
  })

  it('verifies at exactly N and emits the medium event with the streak evidence', async () => {
    const { store, pipeline } = await seed(3)
    expect(await pipeline.verify('2026-11-09T10:00:00+08:00')).toEqual([pipeline.records()[0]!.recordId])
    const record = pipeline.records()[0]!
    expect(record.state).toBe('verified-resolved')
    expect(record.verifiedAt).toBe('2026-11-09T10:00:00+08:00')
    expect(record.resolution.at(-1)?.kind).toBe('green')
    const event = [...store.events.values()].find((item) => item.kind === 'error-record-verified')!
    expect(event.level).toBe('medium')
    expect(event.evidence.some((item) => item.field.endsWith('.greenStreak') && item.after === 3)).toBe(true)
  })

  it('reads a streak below N even when the last run was ok (lastStatus is not the evidence)', async () => {
    const { pipeline } = await seed(0)
    expect(await pipeline.verify()).toEqual([])
    expect(pipeline.records()[0]!.state).toBe('fix-applied')
  })

  it('leaves fix-applied rows alone when the job record is absent (jiuwenswarm unattributed)', async () => {
    const store = memoryTables()
    const pipeline = new ErrorPipeline({ tables: store.tables, greenRunsToVerify: 3, retentionDays: 90 })
    await pipeline.ingest([{ ...entryAt('2026-11-07T16:03:18.272+08:00'), sourceId: 'jiuwen-gmk', jobId: 'unknown-job' }], { autoAnalyze: false })
    const record = pipeline.records()[0]!
    await pipeline.save({ ...record, state: 'fix-applied' })
    expect(await pipeline.verify()).toEqual([])
  })

  it('never verifies twice (a record already resolved stays put)', async () => {
    const { pipeline } = await seed(3)
    await pipeline.verify('2026-11-09T10:00:00+08:00')
    const record = pipeline.records()[0]!
    expect(await pipeline.verify('2026-11-10T10:00:00+08:00')).toEqual([])
    expect(pipeline.records()[0]!.resolution.filter((step) => step.kind === 'green')).toHaveLength(record.resolution.filter((step) => step.kind === 'green').length)
  })
})

describe('ErrorPipeline.retain: only resolved rows leave the ledger', () => {
  const clock = fixedClock('2026-11-09T08:00:00.000+08:00')
  const build = () => {
    const store = memoryTables()
    const pipeline = new ErrorPipeline({ tables: store.tables, greenRunsToVerify: 3, retentionDays: 90, now: clock.now })
    return { store, pipeline }
  }

  it('drops a verified row past the window and its fingerprint, nothing else', async () => {
    const { store, pipeline } = build()
    await pipeline.ingest([entryAt('2026-01-01T00:00:00+08:00')], { autoAnalyze: false })
    await pipeline.ingest([{ ...entryAt('2026-01-01T00:00:00+08:00'), message: 'Todo modify tool invocation failed', jobId: 'cron-todo' }], { autoAnalyze: false })
    const verifiedRecord = pipeline.records().find((record) => record.jobId === 'tools.vision_tools')!
    await pipeline.save({ ...verifiedRecord, state: 'verified-resolved', verifiedAt: '2026-05-01T00:00:00+08:00' })
    const dropped = await pipeline.retain()
    expect(dropped).toEqual([verifiedRecord.recordId])
    expect(store.tables.fingerprints.get(verifiedRecord.signature)).toBeUndefined()
    expect(pipeline.records()).toHaveLength(1)
    expect(pipeline.records()[0]!.state).toBe('open')
  })

  it('keeps a verified row inside the window and never drops unresolved rows', async () => {
    const { pipeline } = build()
    await pipeline.ingest([entryAt('2026-08-01T00:00:00+08:00')], { autoAnalyze: false })
    const record = pipeline.records()[0]!
    await pipeline.save({ ...record, state: 'verified-resolved', verifiedAt: '2026-08-15T00:00:00+08:00' })
    expect(await pipeline.retain()).toEqual([])
  })
})

describe('Event keys: the P4 shape, unique per emit, restart-safe', () => {
  it('composes the four segments (<at>|<subjectKey>|<kind>|<n>) into one path-safe key', async () => {
    const store = memoryTables()
    const clock = fixedClock('2026-11-09T08:00:00.000+08:00')
    const pipeline = new ErrorPipeline({ tables: store.tables, greenRunsToVerify: 3, retentionDays: 90, now: clock.now })
    await pipeline.ingest([entryAt('2026-11-07T16:03:18.272+08:00')], { autoAnalyze: false })
    clock.advance(60_000)
    await pipeline.ingest([{ ...entryAt('2026-11-07T16:03:18.272+08:00'), message: 'another cause', jobId: 'a3f91c7e2b08' }], { autoAnalyze: false })
    const keys = [...store.events.keys()]
    expect(keys).toHaveLength(2)
    for (const key of keys) {
      // `x`, `y`, `z` stand in for the P4/P5 separators, so no bare `|`, `/` or `:` survives.
      expect(/[|/:]/.test(key)).toBe(false)
      const parts = decodeEventKey(key)!
      expect(parts.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:Z|[+-]\d{2}:\d{2})$/)
      expect(parts.subjectKey).toMatch(/^error\/hermes-nas-[0-9a-f]{12}$/)
      expect(parts.kind).toMatch(/^error-record-(opened|reopened|verified)$/)
      expect(parts.index).toBeGreaterThan(0)
    }
    expect(new Set(keys).size).toBe(2)
  })

  it('continues numbering after a restart instead of reusing a key', async () => {
    const store = memoryTables()
    const first = new ErrorPipeline({ tables: store.tables, greenRunsToVerify: 3, retentionDays: 90, now: () => new Date('2026-11-09T08:00:00.000+08:00') })
    await first.ingest([entryAt('2026-11-07T16:03:18.272+08:00')], { autoAnalyze: false })
    const restart = new ErrorPipeline({ tables: store.tables, greenRunsToVerify: 3, retentionDays: 90, now: () => new Date('2026-11-09T08:00:00.000+08:00') })
    await restart.ingest([{ ...entryAt('2026-11-07T16:03:18.272+08:00'), message: 'another cause', jobId: 'a3f91c7e2b08' }], { autoAnalyze: false })
    expect(store.events.size).toBe(2)
  })
})

describe('run-event bridge: script_error rows become error entries', () => {
  const rows = JSON.parse(readFileSync(resolve(root, 'fixtures/hermes/cron-run-events-sample.json'), 'utf8')) as { id: number; job_id: string; event_type: string; status: string | null; detail: string | null; occurred_at: string }[]

  it('replays the measured rows and keeps only script_error', async () => {
    const sqls: string[] = []
    const result = await pullRunEventErrors(
      {
        sourceId: 'hermes-nas',
        dbPath: '/root/.hermes/state.db',
        query: async (sql) => {
          sqls.push(sql)
          return { code: 0, stdout: JSON.stringify(rows) }
        },
      },
      null,
    )
    const scriptErrors = rows.filter((row) => row.event_type === 'script_error')
    expect(result.entries).toHaveLength(scriptErrors.length)
    expect(result.rows).toBe(rows.length)
    expect(result.entries[0]!.raw).toBe(`/root/.hermes/state.db#${String(scriptErrors[0]!.id)}`)
    expect(result.entries[0]!.severity).toBe('error')
    expect(JSON.parse(result.cursor.token).runs).toBe(Math.max(...rows.map((row) => row.id)))
    expect(sqls[0]).toContain('id > 0')
  })

  it('asks only for rows past the persisted id', async () => {
    const sqls: string[] = []
    const result = await pullRunEventErrors(
      {
        sourceId: 'hermes-nas',
        dbPath: '/tmp/state.db',
        query: async (sql) => {
          sqls.push(sql)
          return { code: 0, stdout: JSON.stringify(rows.filter((row) => row.id > 3360)) }
        },
      },
      { token: '{"runs":3360}' },
    )
    expect(sqls[0]).toContain('id > 3360')
    expect(result.cursor.token).toBe('{"runs":3365}')
    expect(result.entries.length).toBe(rows.filter((row) => row.id > 3360 && row.event_type === 'script_error').length)
  })

  it('survives a corrupt cursor by reading from zero', async () => {
    const result = await pullRunEventErrors({ sourceId: 'hermes-nas', dbPath: '/tmp/state.db', query: async () => ({ code: 0, stdout: '[]' }) }, { token: 'not json' })
    expect(result.entries).toEqual([])
  })

  it('throws a named error when the read fails', async () => {
    await expect(pullRunEventErrors({ sourceId: 'hermes-nas', dbPath: '/tmp/state.db', query: async () => ({ code: 2, stdout: '', stderr: 'no such table' }) }, null)).rejects.toThrow(/cron_run_events read failed rc=2/)
  })

  it('returns no entries for an empty ledger', async () => {
    const result = await pullRunEventErrors({ sourceId: 'hermes-nas', dbPath: '/tmp/state.db', query: async () => ({ code: 0, stdout: '' }) }, null)
    expect(result.entries).toEqual([])
    expect(result.cursor.token).toBe('{"runs":0}')
  })
})

describe('event-key codec: path-safe, reversible for every shape the fleet produces', () => {
  const subjects = [
    '2026-11-09T00:00:00.000Z|error/hermes-nas-5d086e1fb6d4|error-record-opened|1',
    '2026-11-09T08:00:00.000+08:00|error/jiuwen_gmk-a1b2c3d4e5f6|error-record-verified|4',
    '2026-11-09T08:00:00.000-05:00|error/fixture-hermes-0123456789ab|error-record-reopened|3',
    '2026-11-09T09:00:00.000+08:00|error/a.b-c_d|error-record-opened|5',
    '2026-11-09T09:00:00.000+08:00|error/hermes-nas-5d086e1fb6d4|error-record-verified|9',
  ]

  it('escapes the documented four segments into letters/digits only', () => {
    for (const row of subjects) {
      const [at, subjectKey, kind, index] = row.split('|') as [string, string, string, string]
      const key = eventKeyOf(at, subjectKey, kind, Number(index))
      expect({ key, unsafe: /[|/]/.test(key) }).toEqual({ key, unsafe: false })
    }
  })

  it('round-trips every case', () => {
    for (const row of subjects) {
      const [at, subjectKey, kind, index] = row.split('|') as [string, string, string, string]
      const parts = decodeEventKey(eventKeyOf(at, subjectKey, kind, Number(index)))
      expect(parts).toEqual({ at, subjectKey, kind, index: Number(index) })
    }
  })

  it('rejects a foreign key shape instead of guessing', () => {
    expect(decodeEventKey('2026-11-09T08:00:00.000+08:00|error/x|error-record-opened|1')).toBeNull()
    expect(decodeEventKey('')).toBeNull()
    expect(decodeEventKey('2026...EerrorNxFerrorYrecordYopenedG0')).toBeNull()
  })

  it('is unambiguous: no two sources of one segment share an escape letter', () => {
    for (const [segment, table] of Object.entries(ESCAPE_TABLES) as [string, Record<string, string>][]) {
      const targets = Object.values(table)
      expect({ segment, distinct: new Set(targets).size === targets.length }).toEqual({ segment, distinct: true })
    }
  })
})
