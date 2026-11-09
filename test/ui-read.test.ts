import { describe, expect, it } from 'vitest'
import type { ChangeEvent } from '../contracts/events.ts'
import type { FleetJobRecord, IssueRecord, IssueSnapshot, PrSnapshot, SourceHealth } from '../contracts/records.ts'
import { eventKeyOf as errorEventKeyOf } from '../packages/agent-cron-dashboard/src/fleet/event-key.ts'
import { DOMAIN_NAMES, LEDGER_KEYS, SNAPSHOT_MAX_BYTES, SNAPSHOT_PATH, decodeRow, emptySnapshot, mountP7, snapshotOf, type DomainTables } from '../packages/agent-cron-dashboard/src/ui/p7-routes.ts'

const NOW = new Date('2026-11-09T20:30:00.000+08:00')

function tableOf<T>(rows: Record<string, T>) {
  return { get: (key: string) => rows[key], keys: () => Object.keys(rows) }
}

const PR: PrSnapshot = {
  platform: 'github',
  owner: 'slamdunk111',
  repo: 'agent-cron-dashboard',
  number: 12,
  title: 'P7 board',
  state: 'open',
  draft: false,
  mergeability: 'mergeable',
  reviewDecision: 'approved',
  checksRollup: 'success',
  headSha: 'abc',
  updatedAt: '2026-11-09T10:00:00+08:00',
  firstSeenAt: '2026-11-08T10:00:00+08:00',
  lastSeenAt: '2026-11-09T10:00:00+08:00',
  events: [],
}

const ISSUE: IssueSnapshot = {
  platform: 'github',
  owner: 'slamdunk111',
  repo: 'agent-cron-dashboard',
  number: 3,
  title: 'bug report',
  state: 'open',
  labels: ['bug'],
  assignees: ['me'],
  comments: 4,
  updatedAt: '2026-11-09T09:00:00+08:00',
  lastCommentBy: 'someone',
  lastCommentAt: '2026-11-09T09:00:00+08:00',
  firstSeenAt: '2026-11-08T09:00:00+08:00',
  lastSeenAt: '2026-11-09T09:00:00+08:00',
  events: [],
}

const JOB: FleetJobRecord = {
  sourceId: 'hermes-nas',
  jobId: 'cron-1',
  name: 'nightly',
  schedule: '0 3 * * *',
  script: 'run.sh',
  lastRunAt: '2026-11-09T03:00:00+08:00',
  lastStatus: 'ok',
  greenStreak: 2,
  collectedAt: '2026-11-09T09:00:00+08:00',
}

const ERROR: IssueRecord = {
  recordId: 'hermes-nas-0df790358866',
  signature: '0df790358866aabbcc',
  sourceId: 'hermes-nas',
  jobId: 'cron-1',
  state: 'open',
  severity: 'error',
  count: 3,
  firstSeen: '2026-11-08T10:00:00+08:00',
  lastSeen: '2026-11-09T08:00:00+08:00',
  samples: [{ occurredAt: '2026-11-09T08:00:00+08:00', severity: 'error', message: 'token=secret boom' }],
  analysis: { state: 'pending', rootCauseHypothesis: null, impact: null, suggestedFix: [], confidence: null, needMoreInfo: [], analyzedAt: null, model: null },
  resolution: [],
  verifiedAt: null,
}

const HEALTH: SourceHealth = {
  sourceId: 'hermes-nas',
  state: 'up',
  latencyMs: 120,
  checkedAt: '2026-11-09T09:00:00+08:00',
  message: null,
  consecutiveFailures: 0,
}

function event(at: string, subjectKey: string, kind: ChangeEvent['kind']): ChangeEvent {
  return { level: 'high', kind, subject: { scope: 'fleet', key: subjectKey, label: 'hermes-nas' }, summary: 's', evidence: [], at }
}

function tables(overrides: Partial<DomainTables> = {}): DomainTables {
  const prEvents: Record<string, ChangeEvent> = {
    [errorEventKeyOf('2026-11-09T08:00:00.000+08:00', 'error/hermes-nas-0df790358866', 'error-record-opened', 7)]: event('2026-11-09T08:00:00.000+08:00', 'error/hermes-nas-0df790358866', 'error-record-opened'),
  }
  return {
    pr: tableOf({ 'github/slamdunk111/agent-cron-dashboard/12': PR }),
    issue: tableOf({ 'github/slamdunk111/agent-cron-dashboard/3': ISSUE }),
    jobs: tableOf({ 'hermes-nas/cron-1': JOB }),
    errors: tableOf({ [ERROR.recordId]: ERROR }),
    events: tableOf(prEvents),
    health: tableOf({ 'hermes-nas': HEALTH }),
    ...overrides,
  }
}

describe('snapshotOf: the domain projection', () => {
  it('projects the six tables into the snapshot and names nothing missing', () => {
    const snapshot = snapshotOf(tables(), NOW)
    expect(snapshot.missing).toEqual([])
    expect(snapshot.at).toBe(NOW.toISOString())
    expect(snapshot.community.pr).toHaveLength(1)
    expect(snapshot.community.pr[0]!.key).toBe('github/slamdunk111/agent-cron-dashboard/12')
    expect(snapshot.community.pr[0]!.mergeability).toBe('mergeable')
    expect(snapshot.community.issue[0]!.lastCommentBy).toBe('someone')
    expect(snapshot.fleet.jobs[0]!.greenStreak).toBe(2)
    expect(snapshot.fleet.health[0]!.state).toBe('up')
    expect(snapshot.events).toHaveLength(1)
    expect(snapshot.events[0]!.subjectKey).toBe('error/hermes-nas-0df790358866')
    expect(snapshot.events[0]!.index).toBe(7)
  })

  it('keeps the ledger at exactly six top-level keys and never carries sample text', () => {
    const snapshot = snapshotOf(tables(), NOW)
    expect(snapshot.ledger).toHaveLength(1)
    expect(Object.keys(snapshot.ledger[0]!).sort()).toEqual([...LEDGER_KEYS].sort())
    const serialized = JSON.stringify(snapshot.ledger)
    expect(serialized).not.toContain('token=secret')
    expect(serialized).not.toContain('samples')
    expect(snapshot.ledger[0]!.analysisState).toBe('pending')
  })

  it('names every domain it could not read and still answers with the rest', () => {
    const snapshot = snapshotOf({ pr: tables().pr, jobs: tables().jobs }, NOW)
    expect(snapshot.missing).toEqual(['workbench_snapshot_issue', 'workbench_fleet_errors', 'workbench_events', 'workbench_fleet_health'])
    expect(snapshot.community.pr).toHaveLength(1)
    expect(snapshot.community.issue).toEqual([])
    expect(snapshot.ledger).toEqual([])
  })

  it('sorts the ledger unresolved first, then by lastSeen', () => {
    const rows: Record<string, IssueRecord> = {
      a: { ...ERROR, recordId: 'a', state: 'verified-resolved', lastSeen: '2026-11-09T08:00:00+08:00' },
      b: { ...ERROR, recordId: 'b', state: 'reopened', lastSeen: '2026-11-07T08:00:00+08:00' },
      c: { ...ERROR, recordId: 'c', state: 'open', lastSeen: '2026-11-06T08:00:00+08:00' },
    }
    const snapshot = snapshotOf(tables({ errors: tableOf(rows) }), NOW)
    expect(snapshot.ledger.map((row) => row.state)).toEqual(['open', 'reopened', 'verified-resolved'])
  })

  it('masks text that leaves the storage domain', () => {
    const snapshot = snapshotOf(tables({ pr: tableOf({ x: { ...PR, title: 'see token=abc123 now' } }) }), NOW)
    expect(snapshot.community.pr[0]!.title).not.toContain('token=abc123')
  })

  it('caps the event list at the limit and sets truncated', () => {
    const many: Record<string, ChangeEvent> = {}
    for (let i = 1; i <= 201; i += 1) {
      const at = `2026-11-09T0${String(Math.floor(i / 60) % 10)}:${String(i % 60).padStart(2, '0')}:00.000+08:00`
      many[`${at}|error/x|error-record-verified|${String(i)}`] = { ...event(at, 'error/x', 'error-record-verified'), level: 'medium' }
    }
    const snapshot = snapshotOf(tables({ events: tableOf(many) }), NOW)
    expect(snapshot.events).toHaveLength(200)
    expect(snapshot.truncated).toBe(true)
  })

  it('reports a small snapshot as not truncated', () => {
    expect(snapshotOf(tables(), NOW).truncated).toBe(false)
  })

  it('drops an event whose key disagrees with the body', () => {
    const bad: Record<string, ChangeEvent> = { 'bogus-key': event('2026-11-09T08:00:00.000+08:00', 'error/x', 'error-record-opened') }
    const snapshot = snapshotOf(tables({ events: tableOf(bad) }), NOW)
    expect(snapshot.events).toEqual([])
  })
})

describe('decodeRow: both key shapes the plugins write', () => {
  const body = event('2026-02-09T10:00:00.000+08:00', 'error/hermes-nas-0df790358866', 'error-record-opened')

  it('decodes the P6 encoded key the pipeline writes', () => {
    const key = errorEventKeyOf('2026-02-09T10:00:00.000+08:00', 'error/hermes-nas-0df790358866', 'error-record-opened', 4)
    expect(decodeRow(key, body)).toEqual({ at: body.at, subjectKey: body.subject.key, kind: body.kind, index: 4 })
  })

  it('decodes the literal four-part key P4 and P5 write', () => {
    const key = `${body.at}|${body.subject.key}|${body.kind}|9`
    expect(decodeRow(key, body)).toEqual({ at: body.at, subjectKey: body.subject.key, kind: body.kind, index: 9 })
  })

  it('refuses a key whose segments disagree with the body', () => {
    const key = errorEventKeyOf(body.at, 'error/somebody-else', 'error-record-opened', 1)
    expect(decodeRow(key, body)).toBeNull()
  })

  it('refuses a literal key with the wrong number of segments or a bad index', () => {
    expect(decodeRow('a|b|c', body)).toBeNull()
    expect(decodeRow(`${body.at}|${body.subject.key}|${body.kind}|zero`, body)).toBeNull()
  })
})

describe('mountP7: the read-only route', () => {
  function harness() {
    const registrations: Array<{ kind: string; path: string; resource: () => Promise<Response> }> = []
    const disposed: string[] = []
    const webServer = {
      port: 8080,
      host: '127.0.0.1',
      register(route: { kind: string; path: string; resource: () => Promise<Response> }) {
        registrations.push(route)
        return () => {
          disposed.push(route.path)
        }
      },
    }
    const ctx = {
      get: (key: string) => (key === 'webServer' ? webServer : key === 'workbenchUiSnapshot' ? () => snapshotOf(tables(), NOW) : undefined),
    }
    return { ctx, registrations, disposed }
  }

  it('always hands back a callable disposer, even before the async registration', () => {
    const { ctx } = harness()
    const dispose = mountP7(ctx as never)
    expect(typeof dispose).toBe('function')
    dispose()
  })

  it('registers the exact path and answers the stored snapshot', async () => {
    const { ctx, registrations } = harness()
    const dispose = mountP7(ctx as never)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(registrations).toHaveLength(1)
    expect(registrations[0]!.kind).toBe('exact')
    expect(registrations[0]!.path).toBe(SNAPSHOT_PATH)
    const response = await registrations[0]!.resource()
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
    const body = (await response.json()) as { ledger: unknown[] }
    expect(Array.isArray(body.ledger)).toBe(true)
    dispose()
  })

  it('disposing after registration removes the route once', async () => {
    const { ctx, registrations, disposed } = harness()
    const dispose = mountP7(ctx as never)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(registrations).toHaveLength(1)
    dispose()
    expect(disposed).toEqual([SNAPSHOT_PATH])
  })

  it('disposing before the microtask cancels the registration entirely', async () => {
    const { ctx, registrations } = harness()
    const dispose = mountP7(ctx as never)
    dispose()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(registrations).toHaveLength(0)
  })

  it('stays silent when the profile has no web server', async () => {
    const dispose = mountP7({ get: () => undefined })
    expect(typeof dispose).toBe('function')
    await new Promise((resolve) => setTimeout(resolve, 0))
    dispose()
  })
})

describe('the domain spelling table', () => {
  it('names the six domains and their tables exactly as the P4/P5/P6 mounts read them', () => {
    expect(DOMAIN_NAMES.pr).toEqual({ domain: 'workbench_snapshot_pr', table: 'snapshots' })
    expect(DOMAIN_NAMES.issue).toEqual({ domain: 'workbench_snapshot_issue', table: 'snapshots' })
    expect(DOMAIN_NAMES.jobs).toEqual({ domain: 'workbench_fleet_jobs', table: 'jobs' })
    expect(DOMAIN_NAMES.errors).toEqual({ domain: 'workbench_fleet_errors', table: 'records' })
    expect(DOMAIN_NAMES.events).toEqual({ domain: 'workbench_events', table: 'events' })
    expect(DOMAIN_NAMES.health).toEqual({ domain: 'workbench_fleet_health', table: 'health' })
  })

  it('an empty snapshot names all six domains missing', () => {
    const snapshot = emptySnapshot(NOW)
    expect(snapshot.missing).toHaveLength(6)
    expect(snapshot.ledger).toEqual([])
    expect(snapshot.truncated).toBe(false)
  })
})

describe('snapshotOf: the sorted arms and the masked health message', () => {
  it('orders several rows of each board by their key', () => {
    const pr2 = { ...PR, number: 2 }
    const issue2 = { ...ISSUE, number: 1 }
    const job2 = { ...JOB, jobId: 'cron-0' }
    const health2 = { ...HEALTH, sourceId: 'jiuwen-gmk', message: 'warn: token=abc' }
    const snapshot = snapshotOf(
      {
        pr: tableOf({ b: PR, a: pr2 }),
        issue: tableOf({ b: ISSUE, a: issue2 }),
        jobs: tableOf({ b: JOB, a: job2 }),
        health: tableOf({ b: HEALTH, a: health2 }),
        errors: tableOf({}),
        events: tableOf({}),
      },
      NOW,
    )
    expect(snapshot.community.pr.map((row) => row.number)).toEqual([12, 2])
    expect(snapshot.community.issue.map((row) => row.number)).toEqual([1, 3]) // 'github/.../1' < 'github/.../3'
    expect(snapshot.fleet.jobs.map((row) => row.jobId)).toEqual(['cron-0', 'cron-1'])
    expect(snapshot.fleet.health.map((row) => row.sourceId)).toEqual(['hermes-nas', 'jiuwen-gmk'])
    expect(snapshot.fleet.health[1]!.message).not.toContain('token=abc')
    expect(snapshot.truncated).toBe(false)
  })
})

describe('snapshotOf: the byte ceiling', () => {
  it('shrinks the event list until the body fits and sets truncated', () => {
    const many: Record<string, ChangeEvent> = {}
    for (let i = 0; i < 600; i += 1) {
      const at = `2026-11-09T00:${String(i % 60).padStart(2, '0')}:00.000+08:00`
      const key = `${at}|error/${'r'.repeat(6000) + i}|error-record-verified|${String(i + 1)}`
      many[key] = {
        level: 'medium',
        kind: 'error-record-verified',
        subject: { scope: 'fleet', key: `error/${'r'.repeat(6000) + i}`, label: 'x' },
        summary: 'x'.repeat(400000),
        evidence: [],
        at,
      }
    }
    const snapshot = snapshotOf(tables({ events: tableOf(many) }), NOW)
    expect(snapshot.truncated).toBe(true)
    expect(snapshot.events.length).toBeLessThan(200)
    expect(Buffer.byteLength(JSON.stringify(snapshot), 'utf8')).toBeLessThanOrEqual(SNAPSHOT_MAX_BYTES)
  })
})
