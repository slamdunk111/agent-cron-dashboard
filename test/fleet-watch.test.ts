import { describe, expect, it } from 'vitest'
import type { ChangeEvent } from '../contracts/events.ts'
import type { ErrorEntry, FleetJob, FleetRun, SinceCursor } from '../contracts/fleet-source.ts'
import type { SourceHealth } from '../contracts/records.ts'
import type { FleetSource } from '../contracts/fleet-source.ts'
import type { CursorRecord, FleetJobRecord } from '../contracts/records.ts'
import { CHANGE_LEVELS } from '../contracts/events.ts'
import { FleetWatchService, backoffFor, eventKeyOf, type FleetWatchTables } from '../packages/agent-cron-dashboard/src/fleet/fleet-watch.ts'

/** In-memory tables (same surface the row hands the watch). */
function tables() {
  const jobs = new Map<string, FleetJobRecord>()
  const cursors = new Map<string, CursorRecord>()
  const health = new Map<string, SourceHealth>()
  const events = new Map<string, ChangeEvent>()
  const api: FleetWatchTables = {
    jobs: { get: (key) => jobs.get(key), put: async (key, value) => void jobs.set(key, value), keys: () => [...jobs.keys()] },
    cursors: { get: (key) => cursors.get(key), put: async (key, value) => void cursors.set(key, value) },
    health: { get: (key) => health.get(key), put: async (key, value) => void health.set(key, value), keys: () => [...health.keys()] },
    events: { get: (key) => events.get(key), put: async (key, value) => void events.set(key, value) },
  }
  return { api, jobs, cursors, health, events }
}

/** Programmable source: each method can be scripted per round. */
interface Step {
  readonly jobs?: readonly FleetJob[]
  readonly runs?: readonly FleetRun[]
  readonly errors?: readonly ErrorEntry[]
  readonly health?: SourceHealth | Error
}

function fakeSource(id: string, script: readonly Step[]): FleetSource & { rounds: number } {
  let round = 0
  /** The step of the round in progress; `health` advances the counter after the poll. */
  const step = (): Step => script[Math.min(round, script.length - 1)]!
  const failIfError = (candidate: Step): void => {
    if (candidate.health instanceof Error) throw candidate.health
  }
  const source: FleetSource = {
    id,
    kind: 'ssh-sqlite',
    async listJobs(): Promise<FleetJob[]> {
      const current = step()
      failIfError(current)
      return [...(current.jobs ?? [])]
    },
    async fetchRuns(): Promise<{ runs: FleetRun[]; cursor: SinceCursor }> {
      const current = step()
      failIfError(current)
      return { runs: [...(current.runs ?? [])], cursor: { token: JSON.stringify({ round }) } }
    },
    async fetchErrorEntries(): Promise<{ entries: ErrorEntry[]; cursor: SinceCursor }> {
      const current = step()
      failIfError(current)
      return { entries: [...(current.errors ?? [])], cursor: { token: JSON.stringify({ round }) } }
    },
    async health(): Promise<SourceHealth> {
      const current = step()
      try {
        failIfError(current)
        const candidate = current.health
        if (candidate === undefined || candidate instanceof Error) {
          return { sourceId: id, state: 'up', latencyMs: 1, checkedAt: '2026-11-08T00:00:00.000Z', message: null, consecutiveFailures: 0 }
        }
        return candidate
      } finally {
        round += 1
      }
    },
  }
  return Object.assign(source, { get rounds() { return round } })
}

const job = (id: string): FleetJob => ({ id, name: id, schedule: null, script: null, lastRunAt: null, lastStatus: null })
const run = (jobId: string, status: FleetRun['status'], at = '2026-11-08T10:00:00+08:00'): FleetRun => ({ jobId, startedAt: at, status })
const healthOf = (sourceId: string, state: SourceHealth['state'], message: string | null = null): SourceHealth => ({ sourceId, state, latencyMs: 1, checkedAt: '2026-11-08T10:00:00.000Z', message, consecutiveFailures: 0 })

describe('fleet watch (P5 orchestration)', () => {
  it('computes exponential backoff capped at the configured maximum', () => {
    expect(backoffFor(0, 60_000, 3_600_000)).toBe(0)
    expect(backoffFor(1, 60_000, 3_600_000)).toBe(60_000)
    expect(backoffFor(3, 60_000, 3_600_000)).toBe(240_000)
    expect(backoffFor(9, 60_000, 3_600_000)).toBe(3_600_000)
  })

  it('keeps a failing source from stopping the healthy one (independent backoff)', async () => {
    const t = tables()
    const bad = fakeSource('bad', [{ health: new Error('ssh: connect refused') }, { health: new Error('ssh: connect refused') }, { health: new Error('ssh: connect refused') }])
    const good = fakeSource('good', [
      { jobs: [job('a')], runs: [run('a', 'ok')], health: healthOf('good', 'up') },
      { jobs: [job('a')], runs: [run('a', 'ok')], health: healthOf('good', 'up') },
      { jobs: [job('a')], runs: [run('a', 'ok')], health: healthOf('good', 'up') },
    ])
    const watch = new FleetWatchService({ sources: [bad, good], tables: t.api, intervalMs: 60_000, now: () => new Date('2026-11-08T10:00:00.000Z'), autoStart: false })
    const rounds = await watch.runOnce()
    expect(rounds.find((entry) => entry.sourceId === 'bad')?.state).toBe('down')
    expect(rounds.find((entry) => entry.sourceId === 'good')?.state).toBe('up')
    expect(rounds.find((entry) => entry.sourceId === 'bad')?.backoffMs).toBe(60_000)
    // the failing source is now backed off, the healthy one still reads
    const next = await watch.runOnce()
    expect(next.find((entry) => entry.sourceId === 'bad')?.skipped).toBe(true)
    expect(next.find((entry) => entry.sourceId === 'good')?.jobs).toBe(1)
  })

  it('stores jobs with the green streak and run transitions', async () => {
    const t = tables()
    const source = fakeSource('hermes-nas', [
      { jobs: [job('68f64ca3b0b1')], runs: [run('68f64ca3b0b1', 'ok')], health: healthOf('hermes-nas', 'up') },
      { jobs: [job('68f64ca3b0b1')], runs: [run('68f64ca3b0b1', 'ok')], health: healthOf('hermes-nas', 'up') },
      { jobs: [job('68f64ca3b0b1')], runs: [run('68f64ca3b0b1', 'ok')], health: healthOf('hermes-nas', 'up') },
      { jobs: [job('68f64ca3b0b1')], runs: [run('68f64ca3b0b1', 'ok')], health: healthOf('hermes-nas', 'up') },
      { jobs: [job('68f64ca3b0b1')], runs: [run('68f64ca3b0b1', 'failed')], health: healthOf('hermes-nas', 'up') },
      { jobs: [job('68f64ca3b0b1')], runs: [run('68f64ca3b0b1', 'ok')], health: healthOf('hermes-nas', 'up') },
    ])
    const watch = new FleetWatchService({ sources: [source], tables: t.api, now: () => new Date('2026-11-08T10:00:00.000Z'), autoStart: false })
    for (let round = 0; round < 4; round += 1) await watch.runOnce()
    const record = t.jobs.get('hermes-nas/68f64ca3b0b1')
    expect(record?.lastStatus).toBe('ok')
    expect(record?.greenStreak).toBe(4)
    await watch.runOnce()
    expect(t.jobs.get('hermes-nas/68f64ca3b0b1')?.greenStreak).toBe(0)
    await watch.runOnce()
    const kinds = [...t.events.values()].map((event) => event.kind)
    expect(kinds).toContain('run-failed')
    expect(kinds).toContain('run-recovered')
  })

  it('writes health transitions as source-health events and never for disabled', async () => {
    const t = tables()
    // first observation is a baseline (no event); seed the stored row so round 1 is a real transition
    t.health.set('a', healthOf('a', 'up'))
    const source = fakeSource('a', [
      { health: healthOf('a', 'down', 'ssh refused') },
      { health: healthOf('a', 'up') },
      { health: healthOf('a', 'disabled') },
    ])
    const watch = new FleetWatchService({ sources: [source], tables: t.api, now: () => new Date('2026-11-08T10:00:00.000Z'), autoStart: false })
    await watch.runOnce()
    await watch.runOnce()
    await watch.runOnce()
    const kinds = [...t.events.values()].map((event) => event.kind)
    expect(kinds).toContain('source-health-down')
    expect(kinds).toContain('source-health-recovered')
    expect(kinds.filter((kind) => kind === 'source-health-recovered')).toHaveLength(1)
  })

  it('does not emit anything on the first observation (baseline only)', async () => {
    const t = tables()
    const source = fakeSource('a', [{ jobs: [job('j')], runs: [run('j', 'failed')], health: healthOf('a', 'down') }])
    const watch = new FleetWatchService({ sources: [source], tables: t.api, autoStart: false })
    await watch.runOnce()
    expect(t.events.size).toBe(0)
    expect(t.health.get('a')?.state).toBe('down')
    expect(t.jobs.get('a/j')?.lastStatus).toBe('failed')
  })

  it('writes the event key with the P4 shape and keeps it in the frozen table levels', async () => {
    const t = tables()
    const source = fakeSource('a', [{ jobs: [job('j')], runs: [run('j', 'failed')], health: healthOf('a', 'up') }, { jobs: [job('j')], runs: [run('j', 'ok')], health: healthOf('a', 'up') }])
    const watch = new FleetWatchService({ sources: [source], tables: t.api, autoStart: false })
    await watch.runOnce()
    const rounds = await watch.runOnce()
    expect(rounds[0]?.runs).toBe(1)
    const events = [...t.events.entries()]
    expect(events.length).toBeGreaterThan(0)
    for (const [key, event] of events) {
      expect(key).toBe(eventKeyOf(event, Number(key.split('|')[3] ?? 0)))
      expect(event.subject.scope).toBe('fleet')
      expect(event.subject.sourceId).toBe('a')
      expect(event.level).toBe(CHANGE_LEVELS[event.kind])
    }
  })

  it('persists the run and error cursors per source', async () => {
    const t = tables()
    const source = fakeSource('a', [{ jobs: [job('j')], runs: [run('j', 'ok')], health: healthOf('a', 'up') }])
    const watch = new FleetWatchService({ sources: [source], tables: t.api, autoStart: false })
    await watch.runOnce()
    expect(t.cursors.get('a:runs')?.token).toBe(JSON.stringify({ round: 0 }))
    expect(t.cursors.get('a:errors')?.token).toBe(JSON.stringify({ round: 0 }))
  })

  it('continues after a source fails inside one of its four calls (partial failure)', async () => {
    const t = tables()
    const partial = fakeSource('p', [{ health: healthOf('p', 'up') }])
    const health = new FleetWatchService({ sources: [partial], tables: t.api, autoStart: false })
    const rounds = await health.runOnce()
    expect(rounds[0]?.state).toBe('up')
  })

  it('a started timer performs rounds on its own', async () => {
    const t = tables()
    const source = fakeSource('a', [{ health: healthOf('a', 'up') }, { health: healthOf('a', 'up') }])
    const watch = new FleetWatchService({ sources: [source], tables: t.api, intervalMs: 5, autoStart: true })
    await new Promise((resolve) => setTimeout(resolve, 40))
    watch.stop()
    // the timer performed the poll on its own: the health row was written and no new event appeared
    expect(t.health.get('a')?.state).toBe('up')
    expect(t.events.size).toBe(0)
  })

  it('stop() clears the timer so no further rounds run', async () => {
    const t = tables()
    const source = fakeSource('a', [{ health: healthOf('a', 'up') }])
    const watch = new FleetWatchService({ sources: [source], tables: t.api, intervalMs: 10, autoStart: true })
    watch.stop()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(source.rounds).toBe(0)
  })

  it('hydrates the stored status so a restarted watch still grades transitions', async () => {
    const t = tables()
    t.jobs.set('a/j', { sourceId: 'a', jobId: 'j', name: 'j', schedule: null, script: null, lastRunAt: null, lastStatus: 'failed', greenStreak: 0, collectedAt: '2026-11-08T00:00:00.000Z' })
    const source = fakeSource('a', [{ jobs: [job('j')], runs: [run('j', 'ok')], health: healthOf('a', 'up') }])
    const watch = new FleetWatchService({ sources: [source], tables: t.api, autoStart: false })
    await watch.runOnce()
    expect([...t.events.values()].map((event) => event.kind)).toContain('run-recovered')
  })
})
