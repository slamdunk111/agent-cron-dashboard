import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { resolveIdentities, redact, spawnGh, type PlatformIdentity } from '../packages/agent-cron-dashboard/src/community/identity.ts'
import { seedPullRequests, parseRepo, lastPageOf } from '../packages/agent-cron-dashboard/src/community/seeding.ts'
import { mergeabilityOf, reviewDecisionOf, rollupOf } from '../packages/agent-cron-dashboard/src/community/github.ts'
import { PrWatchService, QUEUE_CAPACITY, watchKey, type WatchRef, type WatchSource } from '../packages/agent-cron-dashboard/src/community/pr-watch.ts'
import type { PrSnapshot } from '../contracts/records.ts'

const root = resolve(import.meta.dirname, '..')
const gitcodePage = JSON.parse(readFileSync(resolve(root, 'fixtures/gitcode/pulls-mine-all-p1.json'), 'utf8'))
const githubPull = JSON.parse(readFileSync(resolve(root, 'fixtures/github/pull-75.json'), 'utf8'))
const githubStatus = JSON.parse(readFileSync(resolve(root, 'fixtures/github/status-uni-core-75.json'), 'utf8'))
const vllmStatus = JSON.parse(readFileSync(resolve(root, 'fixtures/github/status-vllm-14240.json'), 'utf8'))

const githubIdentity: PlatformIdentity = {
  platform: 'github',
  login: 'slamdunk111',
  state: 'up',
  message: null,
  checkedAt: '2026-11-08T16:00:00+08:00',
  tokenEnv: undefined,
}

function gitcodeIdentity(overrides: Partial<PlatformIdentity> = {}): PlatformIdentity {
  return {
    platform: 'gitcode',
    login: 'nawenyu139',
    state: 'up',
    message: null,
    checkedAt: '2026-11-08T16:00:00+08:00',
    tokenEnv: 'GITCODE_TOKEN',
    ...overrides,
  }
}

/** In-memory table used by the watch tests (single-key atomic writes). */
function memoryTables() {
  const prs = new Map<string, PrSnapshot>()
  const cursors = new Map<string, { token: string; updatedAt: string }>()
  return {
    prTable: {
      get: (key: string) => prs.get(key),
      put: async (key: string, value: PrSnapshot) => {
        prs.set(key, value)
      },
    },
    cursors: {
      get: (key: string) => cursors.get(key),
      put: async (key: string, value: { token: string; updatedAt: string }) => {
        cursors.set(key, value)
      },
      delete: async (key: string) => cursors.delete(key),
    },
    prs,
    cursorMap: cursors,
  }
}

const ref = { platform: 'gitcode' as const, owner: 'openJiuwen', repo: 'jiuwenswarm', number: 9722 } satisfies WatchRef

describe('identity: three states with a named cause (D5)', () => {
  it('reports a missing token without asking the host', async () => {
    const [github, gitcode] = await resolveIdentities({
      identities: [{ platform: 'github', username: 'slamdunk111' }, { platform: 'gitcode', username: 'nawenyu139', tokenEnv: 'GITCODE_TOKEN' }],
      env: {},
      gh: async () => 'unused',
      transport: { get: async () => ({ status: 200, text: '{}' }) },
    })
    expect(github.state).toBe('up')
    expect(gitcode.state).toBe('down')
    expect(gitcode.message).toContain('no token in GITCODE_TOKEN')
  })

  it('treats a refused token as down and says so', async () => {
    const [, gitcode] = await resolveIdentities({
      identities: [{ platform: 'gitcode', username: 'nawenyu139', tokenEnv: 'GITCODE_TOKEN' }],
      env: { GITCODE_TOKEN: 'FAKE-TOKEN-FOR-TEST' },
      transport: { get: async () => ({ status: 403, text: '{"error_message":"no scopes:read_user"}' }) },
    })
    expect(gitcode.state).toBe('down')
    expect(gitcode.message).toContain('GitCode /user refused: HTTP 403')
  })

  it('marks a token that belongs to somebody else as degraded, keeping the configured login', async () => {
    const [, gitcode] = await resolveIdentities({
      identities: [{ platform: 'gitcode', username: 'nawenyu139', tokenEnv: 'GITCODE_TOKEN' }],
      env: { GITCODE_TOKEN: 'OTHER-TOKEN' },
      transport: { get: async () => ({ status: 200, text: '{"login":"someone-else"}' }) },
    })
    expect(gitcode.state).toBe('degraded')
    expect(gitcode.login).toBe('nawenyu139')
    expect(gitcode.message).toContain('token belongs to someone-else')
  })

  it('discovers the GitHub login from the gh CLI when the row omits it', async () => {
    const [github] = await resolveIdentities({
      identities: [{ platform: 'github' }],
      env: {},
      gh: async (args) => {
        expect(args).toEqual(['api', 'user', '--jq', '.login'])
        return 'slamdunk111\n'
      },
    })
    expect(github.login).toBe('slamdunk111')
    expect(github.state).toBe('up')
  })

  it('names an unusable gh CLI instead of throwing', async () => {
    const [github] = await resolveIdentities({
      identities: [{ platform: 'github' }],
      env: {},
      gh: async () => {
        throw new Error('not logged in')
      },
    })
    expect(github.state).toBe('down')
    expect(github.message).toContain('gh CLI unavailable or signed out')
  })

  it('redacts the token (and the value echoed inside a message) everywhere', async () => {
    const secret = 'XAI_P2_CANARY'
    const printed: string[] = []
    const original = console.log
    console.log = (line: string) => printed.push(String(line))
    try {
      await resolveIdentities({
        identities: [{ platform: 'gitcode', username: 'nawenyu139', tokenEnv: 'GITCODE_TOKEN' }],
        env: { GITCODE_TOKEN: secret },
        transport: { get: async () => ({ status: 403, text: JSON.stringify({ error_message: `invalid token: ${secret}` }) }) },
        // No sink: the module's own default sink redacts before printing.
      })
    } finally {
      console.log = original
    }
    expect(printed.join('\n')).not.toContain(secret)
    expect(printed.join('\n')).toContain('***')
  })

  it('redact replaces a secret inside a longer string', () => {
    expect(redact('xXAI_P2_CANARYy', ['XAI_P2_CANARY'])).toBe('x***y')
    expect(redact('nothing', [''])).toBe('nothing')
  })
})

describe('seeding: page rules and author filter match the fixtures', () => {
  it('reads the rel=last page from a Link header', () => {
    expect(lastPageOf('<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=7>; rel="last"')).toBe(7)
    expect(lastPageOf(null)).toBeUndefined()
  })

  it('parses repository URLs of both hosts', () => {
    expect(parseRepo('https://github.com/dptech-corp/Uni-Core')).toEqual({ host: 'github.com', owner: 'dptech-corp', name: 'Uni-Core' })
    expect(parseRepo('https://gitcode.com/openJiuwen/jiuwenswarm')).toEqual({ host: 'gitcode.com', owner: 'openJiuwen', name: 'jiuwenswarm' })
    expect(parseRepo('https://example.com/a/b')).toBeUndefined()
  })

  it('collects only the configured author from the GitCode list (fixture replay)', async () => {
    const outcome = await seedPullRequests({
      repos: ['https://gitcode.com/openJiuwen/jiuwenswarm'],
      identities: [githubIdentity, gitcodeIdentity()],
      identitiesConfig: [{ platform: 'gitcode', username: 'nawenyu139', tokenEnv: 'GITCODE_TOKEN' }],
      env: { GITCODE_TOKEN: 'SEED-TOKEN' },
      transport: {
        get: async () => ({ status: 200, text: JSON.stringify(gitcodePage[0].items) }),
      },
    })
    expect(outcome.seeded.every((item) => item.platform === 'gitcode')).toBe(true)
    expect(outcome.seeded.map((item) => item.number).sort()).toEqual([9704, 9706, 9707, 9722])
  })

  it('names the degradation and seeds nothing when the token is missing (D8)', async () => {
    const outcome = await seedPullRequests({
      repos: ['https://gitcode.com/openJiuwen/jiuwenswarm'],
      identities: [githubIdentity, gitcodeIdentity({ state: 'down', message: 'no token' })],
      identitiesConfig: [{ platform: 'gitcode', username: 'nawenyu139', tokenEnv: 'GITCODE_TOKEN' }],
      env: {},
      transport: {
        get: async () => {
          throw new Error('the network must not be touched')
        },
      },
    })
    expect(outcome.seeded).toHaveLength(0)
    const health = outcome.health.find((row) => row.sourceId === 'community:seed:gitcode')
    expect(health?.state).toBe('degraded')
    expect(health?.message).toContain('GitCode seeding skipped')
  })

  it('stops at the first short page', async () => {
    const calls: string[] = []
    const rows = gitcodePage[0].items.slice(0, 3)
    const outcome = await seedPullRequests({
      repos: ['https://gitcode.com/openJiuwen/jiuwenswarm'],
      identities: [githubIdentity, gitcodeIdentity()],
      identitiesConfig: [{ platform: 'gitcode', username: 'nawenyu139', tokenEnv: 'GITCODE_TOKEN' }],
      env: { GITCODE_TOKEN: 'SEED-TOKEN' },
      transport: {
        get: async (url) => {
          calls.push(url)
          return { status: 200, text: JSON.stringify(rows) }
        },
      },
    })
    expect(calls).toHaveLength(1)
    expect(outcome.seeded.length).toBeLessThanOrEqual(3)
  })

  it('refuses to invent a GitHub page and names the truncation', async () => {
    const outcome = await seedPullRequests({
      repos: ['https://github.com/dptech-corp/Uni-Core'],
      identities: [githubIdentity, gitcodeIdentity({ state: 'down', message: 'no token' })],
      transport: {
        get: async () => ({ status: 200, text: JSON.stringify([githubPull]), link: '<https://api.github.com/x?page=3>; rel="last"' }),
      },
    })
    const health = outcome.health.find((row) => row.sourceId === 'community:seed:github')
    expect(health?.state).toBe('degraded')
    expect(health?.message).toContain('only page 1 read')
    expect(outcome.seeded.map((item) => item.number)).toEqual([75])
  })

  it('marks fork-originated requests instead of dropping them', async () => {
    const forkPull = { ...githubPull, head: { ...githubPull.head, repo: { owner: { login: 'someone-else' } } } }
    const outcome = await seedPullRequests({
      repos: ['https://github.com/dptech-corp/Uni-Core'],
      identities: [githubIdentity],
      transport: { get: async () => ({ status: 200, text: JSON.stringify([forkPull]) }) },
    })
    expect(outcome.seeded[0]?.sourceId).toBe('github:fork:someone-else')
  })
})

describe('github reader: mapping and fail-closed rollup', () => {
  it('maps mergeability with blocked/unstable as unknown, never mergeable', () => {
    expect(mergeabilityOf({ mergeable: true, mergeable_state: 'clean' })).toBe('mergeable')
    expect(mergeabilityOf({ mergeable: true, mergeable_state: 'blocked' })).toBe('unknown')
    expect(mergeabilityOf({ mergeable: false, mergeable_state: 'dirty' })).toBe('conflicting')
    expect(mergeabilityOf({ mergeable: null, mergeable_state: null })).toBe('unknown')
  })

  it('reads an empty status/check list as none (measured shape)', () => {
    expect(rollupOf({ state: 'pending', total_count: 0 }, { total_count: 0 }).rollup).toBe('none')
  })

  it('fails closed on an unknown conclusion', () => {
    const result = rollupOf(undefined, { total_count: 1, check_runs: [{ conclusion: 'zap' }] })
    expect(result.rollup).toBe('failure')
    expect(result.unknown).toBe('zap')
  })

  it('takes the worst of status and check-runs', () => {
    expect(rollupOf({ total_count: 2, statuses: [{ state: 'success' }] }, { total_count: 12, check_runs: [{ conclusion: 'failure' }] }).rollup).toBe('failure')
    expect(rollupOf({ total_count: 1, statuses: [{ state: 'pending' }] }, { total_count: 0 }).rollup).toBe('pending')
    expect(rollupOf({ total_count: 2, statuses: [{ state: 'success' }] }, { total_count: 12, check_runs: [{ conclusion: 'skipped' }, { conclusion: 'success' }] }).rollup).toBe('success')
  })

  it('derives reviewDecision from the latest review per user', () => {
    expect(reviewDecisionOf([{ user: { login: 'a' }, state: 'APPROVED', submitted_at: '2026-11-08T01:00:00Z' }])).toBe('approved')
    expect(
      reviewDecisionOf([
        { user: { login: 'a' }, state: 'APPROVED', submitted_at: '2026-11-08T01:00:00Z' },
        { user: { login: 'b' }, state: 'CHANGES_REQUESTED', submitted_at: '2026-11-08T02:00:00Z' },
      ]),
    ).toBe('changes-requested')
    expect(reviewDecisionOf(undefined)).toBe('none')
  })

  it('keeps the measured samples consistent', () => {
    expect(githubStatus.check_conclusions).toEqual([])
    expect(vllmStatus.check_conclusions).toContain('failure')
  })
})

describe('pr watch: first observation, queue and crash recovery', () => {
  /** A fake source that lets the test push updates and settle the async handler. */
  function fakeSource() {
    let listener: ((u: never) => void) | undefined
    const source: WatchSource = {
      subscribe: (_ref, incoming) => {
        listener = incoming as never
        return () => {}
      },
    }
    const emit = async (update: Record<string, unknown>): Promise<void> => {
      if (listener === undefined) throw new Error('watch source has no listener')
      listener(update as never)
      // The handler awaits its storage writes; let the microtask queue drain.
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 40))
    }
    return { source, emit }
  }

  /** Stored `PrSnapshot` row built from the poll snapshot the fake source emits. */
  const snapshotOfStored = (target: WatchRef, poll: { title: string; state: 'open' | 'closed' | 'merged'; draft: boolean; mergeability: 'mergeable' | 'conflicting' | 'unknown'; reviewDecision: 'approved' | 'changes-requested' | 'review-required' | 'none'; checksRollup: 'none' | 'pending' | 'success' | 'failure'; headSha: string; updatedAt: string }) => ({
    platform: target.platform,
    owner: target.owner,
    repo: target.repo,
    number: target.number,
    title: poll.title,
    state: poll.state,
    draft: poll.draft,
    mergeability: poll.mergeability,
    reviewDecision: poll.reviewDecision,
    checksRollup: poll.checksRollup,
    headSha: poll.headSha,
    updatedAt: poll.updatedAt,
    firstSeenAt: 'x',
    lastSeenAt: 'x',
    events: [],
  })
  const snapshotAt = (headSha: string, extra: Record<string, unknown> = {}) => ({
    state: 'open' as const,
    draft: false,
    mergeability: 'mergeable' as const,
    reviewDecision: 'none' as const,
    checksRollup: 'success' as const,
    headSha,
    title: 'x',
    updatedAt: '2026-11-08T08:00:00Z',
    ...extra,
  })

  it('writes the snapshot once and queues the first pair with before=null', async () => {
    const tables = memoryTables()
    const pairs: unknown[] = []
    const seen: string[] = []
    const { source: watchSource, emit } = fakeSource()
    const service = new PrWatchService({
      prTable: tables.prTable,
      cursors: tables.cursors,
      sources: { gitcode: watchSource },
      log: (line: string) => {
        seen.push(line)
      },
      onPair: (pair) => pairs.push(pair),
    })
    service.applyWatchSet([ref])
    await emit({ key: watchKey(ref), fetchedAt: Date.UTC(2026, 10, 8, 8, 0, 0), snapshot: snapshotAt('a1'), __probe: seen })
    expect(tables.prs.get(watchKey(ref))?.events).toEqual([])
    const queue = JSON.parse(tables.cursors.get(`${watchKey(ref)}:queue`)?.token ?? '{}')
    expect(queue.pairs).toHaveLength(1)
    expect(queue.pairs[0].before).toBeNull()
    expect(queue.applied).toBe(1)
    expect(pairs).toHaveLength(1)
  })

  it('does not repeat the first pair after a restart (the snapshot table decides)', async () => {
    const tables = memoryTables()
    const { source: watchSource, emit } = fakeSource()
    const first = new PrWatchService({ prTable: tables.prTable, cursors: tables.cursors, sources: { gitcode: watchSource }, log: () => {} })
    first.applyWatchSet([ref])
    await emit({ key: watchKey(ref), fetchedAt: Date.UTC(2026, 10, 8, 8, 0, 0), snapshot: snapshotAt('a1') })
    const second = new PrWatchService({ prTable: tables.prTable, cursors: tables.cursors, sources: { gitcode: watchSource }, log: () => {} })
    second.applyWatchSet([ref])
    await emit({ key: watchKey(ref), fetchedAt: Date.UTC(2026, 10, 8, 8, 5, 0), snapshot: snapshotAt('a1') })
    const queue = JSON.parse(tables.cursors.get(`${watchKey(ref)}:queue`)?.token ?? '{}')
    expect(queue.pairs).toHaveLength(1)
    expect(second.roundCounts.get('gitcode')).toBe(1)
  })

  it('evicts the oldest change pair while keeping the first-observation pair', async () => {
    const tables = memoryTables()
    const { source: watchSource, emit } = fakeSource()
    const service = new PrWatchService({ prTable: tables.prTable, cursors: tables.cursors, sources: { gitcode: watchSource }, log: () => {} })
    const key = watchKey(ref)
    const poll = snapshotAt('a1')
    const changePair = (headSha: string) => ({ key, before: { ...poll }, after: { ...poll, headSha }, at: '2026-11-08T08:00:00Z' })
    const firstPair = { key, before: null, after: { ...poll }, at: '2026-11-08T08:00:00Z' }
    const preSeeded = {
      pairs: [...Array.from({ length: QUEUE_CAPACITY - 1 }, (_, index) => changePair(`m${index}`)), firstPair],
      dropped: 0,
      applied: 39,
      nextSeq: 40,
      pending: null,
      lastApplied: null,
    }
    tables.cursors.put(`${key}:queue`, { token: JSON.stringify(preSeeded), updatedAt: 'x' })
    tables.prTable.put(key, snapshotOfStored(ref, poll))
    service.applyWatchSet([ref])
    await emit({ key, fetchedAt: Date.UTC(2026, 10, 8, 8, 30, 0), snapshot: snapshotAt('a2') })
    const queue = JSON.parse(tables.cursors.get(`${key}:queue`)?.token ?? '{}')
    expect(queue.pairs).toHaveLength(QUEUE_CAPACITY)
    expect(queue.pairs.some((entry: { before: unknown }) => entry.before === null)).toBe(true)
    expect(queue.dropped).toBeGreaterThan(0)
  })

  it('drains the queue without touching the snapshot or the applied cursor', async () => {
    const tables = memoryTables()
    const { source: watchSource, emit } = fakeSource()
    const service = new PrWatchService({ prTable: tables.prTable, cursors: tables.cursors, sources: { gitcode: watchSource }, log: () => {} })
    service.applyWatchSet([ref])
    await emit({ key: watchKey(ref), fetchedAt: Date.UTC(2026, 10, 8, 8, 0, 0), snapshot: snapshotAt('a1') })
    const drained = await service.drainQueue(watchKey(ref))
    expect(drained).toHaveLength(1)
    const queue = JSON.parse(tables.cursors.get(`${watchKey(ref)}:queue`)?.token ?? '{}')
    expect(queue.pairs).toHaveLength(0)
    expect(queue.applied).toBe(1)
    expect(tables.prs.get(watchKey(ref))).toBeDefined()
  })

  it('never throws when a listener gets a failure', async () => {
    const tables = memoryTables()
    const { source: watchSource, emit } = fakeSource()
    const lines: string[] = []
    const service = new PrWatchService({ prTable: tables.prTable, cursors: tables.cursors, sources: { gitcode: watchSource }, log: (line) => lines.push(line) })
    service.applyWatchSet([ref])
    await emit({ key: watchKey(ref), fetchedAt: Date.UTC(2026, 10, 8, 8, 0, 0), failure: { code: 'unavailable', message: 'boom' } })
    expect(tables.prs.size).toBe(0)
    expect(lines.join('\n')).toContain('state=degraded')
  })

  it('stops watches it no longer needs', async () => {
    let disposed = 0
    const tables = memoryTables()
    const service = new PrWatchService({
      prTable: tables.prTable,
      cursors: tables.cursors,
      sources: { gitcode: { subscribe: () => () => { disposed += 1 } } },
      log: () => {},
    })
    service.applyWatchSet([ref])
    service.applyWatchSet([])
    service.dispose()
    expect(disposed).toBeGreaterThan(0)
    expect(service.size).toBe(0)
  })
})
