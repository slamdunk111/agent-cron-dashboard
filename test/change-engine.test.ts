import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ChangeEvent, SnapshotPair } from '../contracts/events.ts'
import { CHANGE_LEVELS } from '../contracts/events.ts'
import type { IssueSnapshot, PrSnapshot } from '../contracts/records.ts'
import {
  COMMUNITY_RULES,
  EVIDENCE_CAP_TRUNCATION_MARKER,
  FLEET_KINDS,
  FIRST_OBSERVATION_KINDS,
  gradePair,
  gradeIssuePair,
  isFirstObservation,
} from '../packages/agent-cron-dashboard/src/core/grade.ts'
import { ChangeEngine, EVIDENCE_CAP, RING_SIZE } from '../packages/agent-cron-dashboard/src/core/change-engine.ts'
import { NotifyService, makeEventLog } from '../packages/agent-cron-dashboard/src/core/notify.ts'
import { DigestController, DIGEST_WINDOW_HOURS, digestPrompt } from '../packages/agent-cron-dashboard/src/core/digest.ts'
import { STATUS_TOOL, STATUS_WINDOW_HOURS, buildStatus } from '../packages/agent-cron-dashboard/src/core/tools-status.ts'
import { NOTIFY_ACTION, NOTIFY_SKILL, notifyDetails, notifyKind, skillText } from '../packages/agent-cron-dashboard/src/core/notify-skill.ts'
import { DOMAINS } from '../packages/agent-cron-dashboard/src/index.ts'

const T0 = '2026-11-09T01:00:00.000Z'

/** One PR snapshot with everything the grader looks at. */
function pr(over: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
    platform: 'github',
    owner: 'o',
    repo: 'r',
    number: 7,
    title: 't',
    state: 'open',
    draft: false,
    mergeability: 'mergeable',
    reviewDecision: 'none',
    checksRollup: 'pending',
    headSha: 'sha-1',
    updatedAt: T0,
    firstSeenAt: T0,
    lastSeenAt: T0,
    events: [],
    ...over,
  }
}

/** One issue snapshot with everything the grader looks at. */
function issue(over: Partial<IssueSnapshot> = {}): IssueSnapshot {
  return {
    platform: 'github',
    owner: 'o',
    repo: 'r',
    number: 9,
    title: 'i',
    state: 'open',
    labels: [],
    assignees: [],
    comments: 0,
    updatedAt: T0,
    lastCommentBy: null,
    lastCommentAt: null,
    firstSeenAt: T0,
    lastSeenAt: T0,
    events: [],
    ...over,
  }
}

/** In-memory engine tables (the row hands domain handles of this shape). */
function tables() {
  const events = new Map<string, ChangeEvent>()
  const prs = new Map<string, PrSnapshot>()
  const issues = new Map<string, IssueSnapshot>()
  const cursors = new Map<string, { token: string; updatedAt: string }>()
  return {
    events,
    prs,
    issues,
    cursors,
    prTable: { get: (key: string) => prs.get(key), put: async (key: string, value: PrSnapshot) => void prs.set(key, value) },
    issueTable: { get: (key: string) => issues.get(key), put: async (key: string, value: IssueSnapshot) => void issues.set(key, value) },
    eventsTable: { get: (key: string) => events.get(key), put: async (key: string, value: ChangeEvent) => void events.set(key, value) },
    cursorsTable: {
      get: (key: string) => cursors.get(key),
      put: async (key: string, value: { token: string; updatedAt: string }) => void cursors.set(key, value),
      delete: async (key: string) => cursors.delete(key),
    },
  }
}

/** Build the engine on top of {@link tables} with a queue the test drains by hand. */
function engineOf(queue: readonly SnapshotPair<unknown>[], nowMs = () => Date.parse(T0)) {
  const store = tables()
  const drained = [...queue] as SnapshotPair<unknown>[]
  const engine = new ChangeEngine({
    events: store.eventsTable,
    prTable: store.prTable,
    issueTable: store.issueTable,
    cursors: store.cursorsTable,
    drainQueue: async () => drained.splice(0),
    me: 'me',
    now: () => new Date(nowMs()),
    log: () => undefined,
  })
  return { store, engine, drained }
}

describe('grading table (plan §2; contracts/events.ts)', () => {
  it('covers every frozen kind: 15 community rules plus 7 fleet kinds', () => {
    expect(COMMUNITY_RULES).toHaveLength(15)
    expect(FLEET_KINDS).toHaveLength(7)
    expect([...COMMUNITY_RULES, ...FLEET_KINDS].sort()).toEqual(Object.keys(CHANGE_LEVELS).sort())
  })

  it('grades every community rule from the frozen table, never from a local copy', () => {
    for (const kind of COMMUNITY_RULES) expect(CHANGE_LEVELS[kind]).toMatch(/^(high|medium)$/)
    expect(CHANGE_LEVELS['pr-seeded']).toBe('medium')
    expect(CHANGE_LEVELS['issue-seeded']).toBe('medium')
  })

  it('emits pr-seeded only for a first observation and never for later pairs', () => {
    const seeded = gradePair(null, pr())
    expect(seeded.map((change) => change.kind)).toEqual(['pr-seeded'])
    expect(seeded[0].level).toBe('medium')
    expect(seeded[0].evidence[0]).toEqual({ field: 'firstSeenAt', before: null, after: T0 })
    expect(gradePair(pr(), pr()).filter((change) => change.kind === 'pr-seeded')).toHaveLength(0)
  })

  it('emits issue-seeded only for a first observation', () => {
    expect(gradeIssuePair(null, issue(), false).map((change) => change.kind)).toEqual(['issue-seeded'])
    expect(gradeIssuePair(issue(), issue(), false)).toEqual([])
  })

  it('grades a merged PR as a single terminal event (no CI event on the same pair)', () => {
    const changes = gradePair(pr({ checksRollup: 'pending' }), pr({ state: 'merged', checksRollup: 'success' }))
    expect(changes.map((change) => change.kind)).toEqual(['pr-merged'])
    expect(changes[0].level).toBe('high')
  })

  it('grades a closed PR as pr-closed (high)', () => {
    const changes = gradePair(pr(), pr({ state: 'closed', checksRollup: 'failure' }))
    expect(changes.map((change) => change.kind)).toEqual(['pr-closed'])
    expect(changes[0].level).toBe('high')
  })

  it('grades mergeability turning conflicting as pr-conflicting (high)', () => {
    const changes = gradePair(pr(), pr({ mergeability: 'conflicting' }))
    expect(changes[0]).toMatchObject({ kind: 'pr-conflicting', level: 'high' })
    expect(changes[0].evidence[0]).toEqual({ field: 'mergeability', before: 'mergeable', after: 'conflicting' })
  })

  it('grades checks turning failure as pr-ci-failed (high)', () => {
    const changes = gradePair(pr(), pr({ checksRollup: 'failure' }))
    expect(changes[0]).toMatchObject({ kind: 'pr-ci-failed', level: 'high' })
  })

  it('grades review turning changes-requested as high, and approved as no event', () => {
    expect(gradePair(pr(), pr({ reviewDecision: 'changes-requested' }))[0]).toMatchObject({ kind: 'pr-review-changes-requested', level: 'high' })
    // approved is an improvement: no graded kind covers it.
    expect(gradePair(pr({ reviewDecision: 'changes-requested' }), pr({ reviewDecision: 'approved' }))).toEqual([])
  })

  it('grades draft -> ready as pr-draft-ready (medium) and ready -> draft as nothing', () => {
    expect(gradePair(pr({ draft: true }), pr({ draft: false }))[0]).toMatchObject({ kind: 'pr-draft-ready', level: 'medium' })
    expect(gradePair(pr({ draft: false }), pr({ draft: true }))).toEqual([])
  })

  it('grades checks turning success as pr-ci-green (medium), but not while merged', () => {
    expect(gradePair(pr(), pr({ checksRollup: 'success' }))[0]).toMatchObject({ kind: 'pr-ci-green', level: 'medium' })
    expect(gradePair(pr({ checksRollup: 'failure' }), pr({ checksRollup: 'success' }))[0].kind).toBe('pr-ci-green')
  })

  it('grades an update stamp move with a steady verdict and checks as pr-review-comment (medium)', () => {
    const changes = gradePair(pr(), pr({ updatedAt: '2026-11-09T02:00:00.000Z' }))
    expect(changes[0]).toMatchObject({ kind: 'pr-review-comment', level: 'medium' })
    expect(changes[0].summary).toContain('signal=updated-moved')
  })

  it('suppresses pr-review-comment when the verdict or the checks moved on the same pair', () => {
    const changes = gradePair(pr(), pr({ updatedAt: '2026-11-09T02:00:00.000Z', checksRollup: 'failure' }))
    expect(changes.map((change) => change.kind)).toEqual(['pr-ci-failed'])
  })

  it('emits more than one high kind for one pair when several signals moved', () => {
    const changes = gradePair(pr(), pr({ mergeability: 'conflicting', checksRollup: 'failure', reviewDecision: 'changes-requested' }))
    expect(changes.map((change) => change.kind)).toEqual(['pr-conflicting', 'pr-ci-failed', 'pr-review-changes-requested'])
    expect(changes.every((change) => change.level === 'high')).toBe(true)
  })

  it('grades issue state transitions both ways as medium', () => {
    expect(gradeIssuePair(issue(), issue({ state: 'closed' }), false)[0]).toMatchObject({ kind: 'issue-closed', level: 'medium' })
    expect(gradeIssuePair(issue({ state: 'closed' }), issue(), false)[0]).toMatchObject({ kind: 'issue-reopened', level: 'medium' })
  })

  it('grades label and assignee changes as medium with added/removed evidence', () => {
    const labelled = gradeIssuePair(issue(), issue({ labels: ['bug'] }), false)
    expect(labelled[0].kind).toBe('issue-labeled')
    expect(labelled[0].evidence.map((entry) => entry.field)).toEqual(['labels', 'labelsAdded', 'labelsRemoved'])
    expect(labelled[0].evidence[1].after).toEqual(['bug'])
    const assigned = gradeIssuePair(issue(), issue({ assignees: ['me'] }), false)
    expect(assigned[0].kind).toBe('issue-assigned')
    // Removing a label is the same kind (an "in/out" pair, not two kinds).
    expect(gradeIssuePair(issue({ labels: ['bug'] }), issue(), false)[0].kind).toBe('issue-labeled')
  })

  it('gradeIssuePair does not emit a label event when the member set is unchanged', () => {
    expect(gradeIssuePair(issue({ labels: ['a'] }), issue({ labels: ['a'] }), false)).toEqual([])
  })

  it('grades a new comment as issue-comment, naming whose reply it is', () => {
    const foreign = gradeIssuePair(issue(), issue({ comments: 2, lastCommentBy: 'someone' }), true)
    expect(foreign[0].kind).toBe('issue-comment')
    expect(foreign[0].summary).toContain('reply by someone')
    const own = gradeIssuePair(issue(), issue({ comments: 1, lastCommentBy: 'me' }), false)
    expect(own[0].summary).toContain('self/unknown')
  })

  it('emits no comment event when the comment count did not grow', () => {
    expect(gradeIssuePair(issue({ comments: 3, lastCommentBy: 'a' }), issue({ comments: 3, lastCommentBy: 'b' }), true)).toEqual([])
  })

  it('isFirstObservation names exactly the two ADR kinds', () => {
    expect(FIRST_OBSERVATION_KINDS).toEqual(['pr-seeded', 'issue-seeded'])
    expect(isFirstObservation('pr-seeded')).toBe(true)
    expect(isFirstObservation('issue-seeded')).toBe(true)
    expect(isFirstObservation('pr-ci-failed')).toBe(false)
  })
})

describe('change engine (plan §3.1–§3.2)', () => {
  it('grades a first-observation pair and stores it in the event log', async () => {
    const { store, engine } = engineOf([])
    const pair: SnapshotPair<PrSnapshot> = { key: 'github/o/r/7', before: null, after: pr(), at: T0 }
    const events = await engine.consumePair(pair, 'pr')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'pr-seeded', level: 'medium', subject: { scope: 'community', key: 'github/o/r/7' } })
    expect(store.events.size).toBe(1)
    expect(engine.eventCount).toBe(1)
  })

  it('never merges two first observations of the same subject and kind', async () => {
    const { engine } = engineOf([])
    const first = await engine.consumePair({ key: 'github/o/r/7', before: null, after: pr(), at: T0 }, 'pr')
    const second = await engine.consumePair({ key: 'github/o/r/7', before: null, after: pr({ title: 't2' }), at: T0 }, 'pr')
    expect(first).toHaveLength(1)
    expect(second).toHaveLength(1)
    expect(second[0].summary).not.toContain('×')
    expect(engine.eventCount).toBe(2)
  })

  it('merges the same subject and kind inside the debounce window with a count suffix', async () => {
    let nowMs = Date.parse(T0)
    const { engine } = engineOf([], () => nowMs)
    const base = pr()
    await engine.consumePair({ key: 'github/o/r/7', before: base, after: pr({ checksRollup: 'failure' }), at: T0 }, 'pr')
    nowMs += 60_000
    const merged = await engine.consumePair({ key: 'github/o/r/7', before: pr({ checksRollup: 'failure' }), after: pr({ checksRollup: 'failure', title: 't3' }), at: T0 }, 'pr')
    expect(merged).toHaveLength(0)
  })

  it('merges repeated reports of the same kind into one event carrying the count', async () => {
    let nowMs = Date.parse(T0)
    const { engine } = engineOf([], () => nowMs)
    const events: ChangeEvent[] = []
    const collect = new ChangeEngine({
      events: { get: () => undefined, put: async () => undefined },
      prTable: { get: () => undefined, put: async () => undefined },
      issueTable: { get: () => undefined, put: async () => undefined },
      cursors: { get: () => undefined, put: async () => undefined, delete: async () => false },
      drainQueue: async () => [],
      now: () => new Date(nowMs),
      log: () => undefined,
      onEvent: (event) => void events.push(event),
    })
    await collect.consumePair({ key: 'github/o/r/7', before: pr(), after: pr({ checksRollup: 'failure' }), at: T0 }, 'pr')
    nowMs += 30_000
    await collect.consumePair({ key: 'github/o/r/7', before: pr({ checksRollup: 'failure' }), after: pr({ checksRollup: 'failure', mergeability: 'unknown' }), at: T0 }, 'pr')
    // The second pair graded to nothing; drive the same kind twice instead.
    nowMs -= 30_000
    await collect.consumePair({ key: 'github/o/r/8', before: pr({ number: 8 }), after: pr({ number: 8, checksRollup: 'failure' }), at: T0 }, 'pr')
    expect(events).toHaveLength(2)
    expect(events[0].summary).toContain('checks pending -> failure')
    void engine
  })

  it('re-opens the window after the debounce period elapsed', async () => {
    let nowMs = Date.parse(T0)
    const fired: ChangeEvent[] = []
    const engine = new ChangeEngine({
      events: { get: () => undefined, put: async () => undefined },
      prTable: { get: () => undefined, put: async () => undefined },
      issueTable: { get: () => undefined, put: async () => undefined },
      cursors: { get: () => undefined, put: async () => undefined, delete: async () => false },
      drainQueue: async () => [],
      now: () => new Date(nowMs),
      log: () => undefined,
      onEvent: (event) => void fired.push(event),
    })
    const A = pr({ checksRollup: 'success' })
    const B = pr({ checksRollup: 'failure' })
    await engine.consumePair({ key: 'k', before: pr(), after: A, at: T0 }, 'pr')
    nowMs += engine.debounceMs + 1
    await engine.consumePair({ key: 'k', before: A, after: B, at: T0 }, 'pr')
    expect(fired.map((event) => event.summary)).toEqual(['checks pending -> success', 'checks success -> failure'])
  })

  it('keeps the window open at exactly the debounce boundary minus one millisecond', async () => {
    let nowMs = Date.parse(T0)
    const engine = new ChangeEngine({
      events: { get: () => undefined, put: async () => undefined },
      prTable: { get: () => undefined, put: async () => undefined },
      issueTable: { get: () => undefined, put: async () => undefined },
      cursors: { get: () => undefined, put: async () => undefined, delete: async () => false },
      drainQueue: async () => [],
      now: () => new Date(nowMs),
      log: () => undefined,
    })
    await engine.consumePair({ key: 'k', before: pr(), after: pr({ checksRollup: 'success' }), at: T0 }, 'pr')
    nowMs += engine.debounceMs - 1
    const merged = await engine.consumePair({ key: 'k', before: pr(), after: pr({ checksRollup: 'success' }), at: T0 }, 'pr')
    expect(merged).toHaveLength(0)
    expect(engine.windowSize).toBe(1)
  })

  it('caps the evidence of a merged event and marks the truncation', async () => {
    const engine = new ChangeEngine({
      events: { get: () => undefined, put: async () => undefined },
      prTable: { get: () => undefined, put: async () => undefined },
      issueTable: { get: () => undefined, put: async () => undefined },
      cursors: { get: () => undefined, put: async () => undefined, delete: async () => false },
      drainQueue: async () => [],
      now: () => new Date(T0),
      log: () => undefined,
    })
    // Nine graded entries: three signals × three kinds is impossible, so build a
    // pair with six evidence entries via many issue fields instead.
    const before = issue({ labels: ['a'], assignees: ['x'], comments: 0 })
    const after = issue({ labels: ['b'], assignees: ['y'], comments: 1, lastCommentBy: 'me', state: 'closed' })
    const events = await engine.consumePair({ key: 'i', before, after, at: T0 }, 'issue')
    expect(events[0].evidence.length).toBeLessThanOrEqual(EVIDENCE_CAP + 1)
    expect(EVIDENCE_CAP).toBe(8)
    expect(EVIDENCE_CAP_TRUNCATION_MARKER).toBe('evidenceTruncated')
  })

  it('drains a queue through the producer and grades pairs in order', async () => {
    const pair: SnapshotPair<PrSnapshot> = { key: 'github/o/r/7', before: null, after: pr(), at: T0 }
    const { engine, store, drained } = engineOf([pair] as unknown as SnapshotPair<unknown>[])
    const events = await engine.consumeKey('github/o/r/7', 'pr')
    expect(events.map((event) => event.kind)).toEqual(['pr-seeded'])
    expect(drained).toHaveLength(0)
    expect(store.events.size).toBe(1)
  })

  it('reads the queue counters but never rewrites them (batch rule 2)', async () => {
    const { engine, store } = engineOf([])
    const key = 'github/o/r/7'
    const record = { token: JSON.stringify({ pairs: [{ key, before: null, after: pr(), at: T0 }], dropped: 3, applied: 5, nextSeq: 6, pending: null, lastApplied: { seq: 5, before: pr(), after: pr({ title: 'z' }) } }), updatedAt: T0 }
    store.cursors.set(`${key}:queue`, record)
    await engine.consumeKey(key, 'pr')
    expect(store.cursors.get(`${key}:queue`)).toEqual(record)
    expect(engine.lossOf(key, 'pr')).toMatchObject({ dropped: 3 })
  })

  it('names a lost pair count without changing the queue record', async () => {
    const { engine, store } = engineOf([])
    store.cursors.set('github/o/r/7:queue', { token: JSON.stringify({ dropped: 2 }), updatedAt: T0 })
    expect(engine.lossOf('github/o/r/7', 'pr').dropped).toBe(2)
    expect(engine.lossOf('github/o/r/7', 'issue').dropped).toBe(0)
    store.cursors.set('github/o/r/7:issuequeue', { token: 'not-json', updatedAt: T0 })
    expect(engine.lossOf('github/o/r/7', 'issue')).toEqual({ dropped: 0, lastApplied: null })
  })

  it('reports a drain failure as one named line and keeps going', async () => {
    const lines: string[] = []
    const engine = new ChangeEngine({
      events: { get: () => undefined, put: async () => undefined },
      prTable: { get: () => undefined, put: async () => undefined },
      issueTable: { get: () => undefined, put: async () => undefined },
      cursors: { get: () => undefined, put: async () => undefined, delete: async () => false },
      drainQueue: async () => {
        throw new Error('boom')
      },
      log: (line) => void lines.push(line),
    })
    expect(await engine.consumeKey('k', 'pr')).toEqual([])
    expect(lines[0]).toContain('health core:queue:k state=degraded message="drain failed: boom"')
  })

  it('sweeps several keys and counts what each produced', async () => {
    const pairA: SnapshotPair<PrSnapshot> = { key: 'a', before: null, after: pr(), at: T0 }
    const pairB: SnapshotPair<IssueSnapshot> = { key: 'b', before: null, after: issue(), at: T0 }
    const store = tables()
    const queues: Record<string, SnapshotPair<unknown>[]> = { a: [pairA as unknown as SnapshotPair<unknown>], b: [pairB as unknown as SnapshotPair<unknown>] }
    const engine = new ChangeEngine({
      events: store.eventsTable,
      prTable: store.prTable,
      issueTable: store.issueTable,
      cursors: store.cursorsTable,
      drainQueue: async (key: string) => queues[key] ?? [],
      now: () => new Date(T0),
    })
    const swept = await engine.sweep([
      { key: 'a', scope: 'pr' },
      { key: 'b', scope: 'issue' },
    ])
    expect(swept).toEqual({ keys: 2, events: 2 })
  })

  it('appends the event to the subject ring and trims it at the ring size', async () => {
    const store = tables()
    const full = pr({ events: Array.from({ length: RING_SIZE }, (_, index) => eventOf(index)) })
    store.prs.set('github/o/r/7', full)
    const engine = new ChangeEngine({
      events: store.eventsTable,
      prTable: store.prTable,
      issueTable: store.issueTable,
      cursors: store.cursorsTable,
      drainQueue: async () => [],
      now: () => new Date(T0),
    })
    await engine.consumePair({ key: 'github/o/r/7', before: pr(), after: pr({ checksRollup: 'failure' }), at: T0 }, 'pr')
    const stored = store.prs.get('github/o/r/7')
    expect(stored?.events.length ?? -1).toBe(RING_SIZE)
    expect(stored?.events.at(-1)?.kind).toBe('pr-ci-failed')
    expect(RING_SIZE).toBe(50)
  })

  it('skill text and card kind carry the action, skill and details schema', () => {
    const kind = notifyKind()
    expect(kind.action).toBe(NOTIFY_ACTION)
    expect(kind.skill).toBe(NOTIFY_SKILL)
    expect(kind.details.safeParse({ events: [], reason: 'backlog' }).success).toBe(true)
    expect(kind.details.safeParse({ events: [], reason: 'nope' }).success).toBe(false)
    expect(skillText()).toContain('workbench_status')
    expect(skillText()).toContain('pr-seeded')
    expect(notifyDetails.shape.reason.options).toEqual(['live', 'backlog'])
  })

  it('publishes the skill body next to the bundle and keeps it equal to skillText()', () => {
    const body = readFileSync(resolve(import.meta.dirname, '..', 'packages/agent-cron-dashboard/skills/workbench-notify/SKILL.md'), 'utf8')
    expect(body.trimEnd()).toBe(skillText())
  })

  it('declares the workbench_events domain with one events table', () => {
    const domain = DOMAINS.find((spec) => spec.name === 'workbench_events')
    expect(domain?.version).toBe(1)
    expect(Object.keys(domain?.tables ?? {})).toEqual(['events'])
  })
})

describe('notify routing (plan §3.3)', () => {
  const high = (key = 'github/o/r/7'): ChangeEvent =>
    ({ level: 'high', kind: 'pr-ci-failed', subject: { scope: 'community', key, label: '7' }, summary: 'ci failed', evidence: [{ field: 'checksRollup', before: 'pending', after: 'failure' }], at: T0 })

  it('keeps medium events out of the card ledger', () => {
    const notify = new NotifyService({ actionCards: true, agentLive: () => true })
    const medium: ChangeEvent = { ...high(), level: 'medium', kind: 'pr-ci-green' }
    expect(notify.route(medium)).toBe('digest')
    expect(notify.state()).toMatchObject({ pending: 0, digestOnly: 1, actionCards: true })
  })

  it('never cards a first observation even when its level says otherwise', () => {
    const notify = new NotifyService({ actionCards: true, agentLive: () => true })
    const seeded: ChangeEvent = { ...high(), level: 'medium', kind: 'pr-seeded' }
    expect(notify.route(seeded)).toBe('digest')
    expect(notify.state().pending).toBe(0)
  })

  it('queues a high event and hands it to the model once the host is live', () => {
    let live = false
    const notify = new NotifyService({ actionCards: true, agentLive: () => live })
    expect(notify.route(high())).toBe('card')
    expect(notify.takeCards()).toEqual([])
    expect(notify.state()).toMatchObject({ pending: 1, backlog: 1 })
    live = true
    const cards = notify.takeCards()
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ action: 'workbench-notify', title: 'pr-ci-failed: 7' })
    expect(notify.state().pending).toBe(0)
  })

  it('aggregates an offline backlog into one card naming the event count', () => {
    let live = false
    const notify = new NotifyService({ actionCards: true, agentLive: () => live, backlogMergeCount: 2 })
    notify.route(high('a'))
    notify.route(high('b'))
    notify.route(high('c'))
    expect(notify.takeCards()).toEqual([])
    live = true
    const cards = notify.takeCards()
    expect(cards).toHaveLength(1)
    expect(cards[0].brief).toContain('3 事件')
    expect(cards[0].details.reason).toBe('backlog')
    expect(cards[0].details.events).toHaveLength(3)
  })

  it('keeps a one-event backlog as its own card (below the merge floor)', () => {
    let live = false
    const notify = new NotifyService({ actionCards: true, agentLive: () => live, backlogMergeCount: 2 })
    notify.route(high('a'))
    live = true
    const cards = notify.takeCards()
    expect(cards).toHaveLength(1)
    expect(cards[0].details.reason).toBe('backlog')
  })

  it('with actionCards=false the high event is stored only and the line names the switch', () => {
    const lines: string[] = []
    const notify = new NotifyService({ actionCards: false, agentLive: () => true, log: (line) => void lines.push(line) })
    expect(notify.route(high())).toBe('digest')
    expect(notify.state()).toMatchObject({ actionCards: false, pending: 0, dispatched: 0 })
    expect(lines[0]).toContain('notify actionCards=false')
    expect(lines[0]).toContain('关闭态：事件只落库')
    expect(notify.takeCards()).toEqual([])
  })

  it('names an unmounted action-cards service instead of pretending cards work', () => {
    const lines: string[] = []
    const notify = new NotifyService({ actionCards: true, log: (line) => void lines.push(line) })
    notify.markRegistered(false)
    expect(notify.state().cardsRegistered).toBe(false)
    expect(lines[0]).toContain('action-cards service is not mounted')
  })

  it('renders pending cards as the text the skill tells the model to propose', () => {
    let live = false
    const notify = new NotifyService({ actionCards: true, agentLive: () => live })
    notify.route(high())
    expect(notify.renderCards()).toBe('no pending card')
    live = true
    const text = notify.renderCards()
    expect(text).toContain('action=workbench-notify')
    expect(text).toContain('"reason":"backlog"')
  })

  it('reports where an event went through routeLabel', () => {
    const notify = new NotifyService({ actionCards: true, agentLive: () => true })
    expect(notify.routeLabel(high())).toBe('card')
    expect(notify.routeLabel({ ...high(), level: 'medium', kind: 'issue-comment' })).toBe('digest')
    const off = new NotifyService({ actionCards: false })
    expect(off.routeLabel(high())).toBe('digest')
  })

  it('reads the event log window and scope from stored events', async () => {
    const store = tables()
    const old: ChangeEvent = { ...high(), at: '2026-11-01T00:00:00.000Z' }
    store.events.set('old', old)
    store.events.set('new', high())
    const log = makeEventLog({ keys: () => [...store.events.keys()], get: (key) => store.events.get(key) })
    expect(await log.read('2026-11-08T00:00:00.000Z')).toHaveLength(1)
    expect(await log.read('2026-11-01T00:00:00.000Z')).toHaveLength(2)
    expect(await log.read('2026-11-01T00:00:00.000Z', 'fleet')).toHaveLength(0)
  })
})

describe('digest task lifecycle (plan §3.4)', () => {
  interface Task {
    id: string
    title: string
    prompt: string
    status: 'active' | 'paused' | 'ended'
    record: { kind: string; expression: string; timeZone: string }
  }

  /** Fake `ctx.schedule` recording every call. */
  function scheduleOf(initial: Task[] = []) {
    const calls: string[] = []
    const tasks: Task[] = [...initial]
    const port = {
      catalog: async () => [...tasks],
      create: async (request: { title: string; prompt: string; timing: { kind: string; cron: { expression: string; time_zone: string } } }) => {
        calls.push('create')
        tasks.push({
          id: `t-${String(tasks.length + 1)}`,
          title: request.title,
          prompt: request.prompt,
          status: 'active',
          record: { kind: request.timing.kind, expression: request.timing.cron.expression, timeZone: request.timing.cron.time_zone },
        })
        return tasks.at(-1)
      },
      edit: async (request: { id: string; action: 'update'; patch?: Record<string, unknown> } | { id: string; action: 'delete' }) => {
        calls.push(request.action)
        const task = tasks.find((entry) => entry.id === request.id)
        if (request.action === 'delete') {
          const index = tasks.indexOf(task as Task)
          if (index >= 0) tasks.splice(index, 1)
          return { deleted: true }
        }
        if (task !== undefined && request.action === 'update' && request.patch !== undefined) {
          const timing = request.patch.timing as { cron?: { expression: string; time_zone: string } } | undefined
          if (typeof request.patch.prompt === 'string') task.prompt = request.patch.prompt
          if (timing?.cron !== undefined) {
            task.record.expression = timing.cron.expression
            task.record.timeZone = timing.cron.time_zone
          }
        }
        return { ok: true }
      },
    }
    return { port, calls, tasks }
  }

  const base = { enabled: true, cron: '0 9 * * *', timeZone: 'Asia/Shanghai', taskTitle: 'workbench-digest' }

  it('creates the digest task with a cron timing in the configured zone', async () => {
    const { port, calls, tasks } = scheduleOf()
    const controller = new DigestController({ ...base, schedule: port })
    expect(await controller.ensure()).toBe('created')
    expect(calls).toEqual(['create'])
    expect(tasks[0]).toMatchObject({ title: 'workbench-digest', prompt: digestPrompt() })
    expect(tasks[0].record).toEqual({ kind: 'cron', expression: '0 9 * * *', timeZone: 'Asia/Shanghai' })
    expect(controller.timing()).toEqual({ kind: 'cron', cron: { expression: '0 9 * * *', time_zone: 'Asia/Shanghai' } })
  })

  it('is idempotent: a second ensure neither creates nor edits', async () => {
    const { port, calls } = scheduleOf()
    const controller = new DigestController({ ...base, schedule: port })
    expect(await controller.ensure()).toBe('created')
    expect(await controller.ensure()).toBe('unchanged')
    expect(calls).toEqual(['create'])
  })

  it('updates a task whose expression, zone or prompt drifted', async () => {
    const drifted: Task = { id: 't-1', title: 'workbench-digest', prompt: 'old prompt', status: 'active', record: { kind: 'cron', expression: '0 10 * * *', timeZone: 'UTC' } }
    const { port, calls } = scheduleOf([drifted])
    const controller = new DigestController({ ...base, schedule: port })
    expect(await controller.ensure()).toBe('updated')
    expect(calls).toEqual(['update'])
    expect(drifted.record).toEqual({ kind: 'cron', expression: '0 9 * * *', timeZone: 'Asia/Shanghai' })
  })

  it('deletes a duplicate title so the task cannot deliver twice', async () => {
    const first: Task = { id: 't-1', title: 'workbench-digest', prompt: digestPrompt(), status: 'active', record: { kind: 'cron', expression: '0 9 * * *', timeZone: 'Asia/Shanghai' } }
    const second: Task = { id: 't-2', title: 'workbench-digest', prompt: digestPrompt(), status: 'active', record: { kind: 'cron', expression: '0 9 * * *', timeZone: 'Asia/Shanghai' } }
    const { port, calls, tasks } = scheduleOf([first, second])
    const controller = new DigestController({ ...base, schedule: port })
    expect(await controller.ensure()).toBe('unchanged')
    expect(calls).toEqual(['delete'])
    expect(tasks.map((task) => task.id)).toEqual(['t-1'])
  })

  it('removes the task when the digest is switched off, and names the no-task case', async () => {
    const existing: Task = { id: 't-1', title: 'workbench-digest', prompt: digestPrompt(), status: 'active', record: { kind: 'cron', expression: '0 9 * * *', timeZone: 'Asia/Shanghai' } }
    const on = scheduleOf([existing])
    const controller = new DigestController({ ...base, enabled: false, schedule: on.port })
    expect(await controller.ensure()).toBe('deleted')
    expect(on.calls).toEqual(['delete'])
    expect(on.tasks).toHaveLength(0)
    const off = scheduleOf()
    expect(await new DigestController({ ...base, enabled: false, schedule: off.port }).ensure()).toBe('disabled')
    expect(off.calls).toEqual([])
  })

  it('skips (and names it) when the profile mounts no schedule service', async () => {
    const lines: string[] = []
    const controller = new DigestController({ ...base, log: (line) => void lines.push(line) })
    expect(await controller.ensure()).toBe('skipped')
    expect(lines[0]).toContain('schedule service is not mounted')
  })

  it('pins the prompt text and the window the prompt asks for', () => {
    expect(digestPrompt()).toContain('workbench_status')
    expect(digestPrompt()).toContain('24h summary')
    expect(DIGEST_WINDOW_HOURS).toBe(24)
  })

  it('leaves a paused task matching the config alone (no re-activation by ensure)', async () => {
    const paused: Task = { id: 't-1', title: 'workbench-digest', prompt: digestPrompt(), status: 'paused', record: { kind: 'cron', expression: '0 9 * * *', timeZone: 'Asia/Shanghai' } }
    const { port, calls } = scheduleOf([paused])
    expect(await new DigestController({ ...base, schedule: port }).ensure()).toBe('unchanged')
    expect(calls).toEqual([])
  })
})

describe('workbench_status tool (plan §3.5)', () => {
  function sourcesOf(events: readonly ChangeEvent[], prCount = 2, issueCount = 3, fleet: { jobs: number; errors: number } | null = null) {
    const map = new Map(events.map((event, index) => [`e${String(index)}`, event]))
    return { events: { keys: () => [...map.keys()], get: (key: string) => map.get(key) }, prCount: () => prCount, issueCount: () => issueCount, fleet }
  }

  const event = (over: Partial<ChangeEvent> = {}): ChangeEvent => ({
    level: 'high',
    kind: 'pr-ci-failed',
    subject: { scope: 'community', key: 'github/o/r/7', label: '7' },
    summary: 'ci failed',
    evidence: [{ field: 'checksRollup', before: 'pending', after: 'failure' }],
    at: T0,
    ...over,
  })

  it('summarizes the window, the levels and the top kinds', () => {
    const report = buildStatus(sourcesOf([event(), event({ level: 'medium', kind: 'issue-closed' })]), 'all', T0)
    expect(report.stats).toMatchObject({ scope: 'all', high: 1, medium: 1, communitySnapshots: 5 })
    expect(report.stats.topKinds).toHaveLength(2)
    expect(report.text).toContain('scope=all')
    expect(report.text).toContain('high 1, medium 1')
  })

  it('defaults the window to 24 hours before the call', () => {
    const report = buildStatus(sourcesOf([]), 'all', undefined)
    const floor = Date.parse(report.stats.since)
    const now = Date.parse(T0)
    // `now` defaults to the real clock: floor must sit ~24h behind it.
    expect(Math.abs(now - floor) > 0 ? STATUS_WINDOW_HOURS : -1).toBe(24)
    expect(Number.isFinite(floor)).toBe(true)
  })

  it('keeps events at or after the since floor, drops older ones', () => {
    const report = buildStatus({ ...sourcesOf([event(), event({ at: '2026-11-01T00:00:00.000Z' })]), now: () => new Date(T0) }, 'all', '2026-11-08T00:00:00.000Z')
    expect(report.stats.high).toBe(1)
  })

  it('filters by scope and names the fleet placeholder until P5', () => {
    const report = buildStatus(sourcesOf([event()]), 'fleet', T0)
    expect(report.stats.high).toBe(0)
    expect(report.text).toContain('fleet: not wired yet')
    expect(report.stats.fleetJobs).toBeNull()
    const community = buildStatus(sourcesOf([event()]), 'community', T0)
    expect(community.text).not.toContain('fleet:')
  })

  it('renders a fleet row when P5 supplies one', () => {
    const report = buildStatus(sourcesOf([], 1, 1, { jobs: 4, errors: 2 }), 'fleet', T0)
    expect(report.text).toContain('fleet: 4 job(s), 2 error record(s)')
    expect(report.stats.unresolvedErrors).toBe(2)
  })

  it('says "none" for an empty window and never ships an empty list silently', () => {
    const report = buildStatus(sourcesOf([]), 'all', T0)
    expect(report.text).toContain('events: 0 in window')
    expect(report.text).toContain('top kinds: none')
    expect(STATUS_TOOL).toBe('workbench_status')
  })
})

/** A minimal stored event, used to fill the ring. */
function eventOf(index: number): ChangeEvent {
  return {
    level: 'medium',
    kind: 'pr-review-comment',
    subject: { scope: 'community', key: 'github/o/r/7', label: '7' },
    summary: `s${String(index)}`,
    evidence: [{ field: 'updatedAt', before: T0, after: T0 }],
    at: T0,
  }
}

void vi
