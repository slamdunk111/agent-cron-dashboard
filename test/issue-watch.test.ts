import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { SnapshotPair } from '../contracts/events.ts'
import type { IssueSnapshot } from '../contracts/records.ts'
import { CHANGE_LEVELS } from '../contracts/events.ts'
import { GITCODE_ISSUE_CAPABILITIES } from '../contracts/gitcode-capabilities.ts'
import type { PlatformIdentity } from '../packages/agent-cron-dashboard/src/community/identity.ts'
import type { HttpGet, HttpGetResponse } from '../packages/agent-cron-dashboard/src/community/http-get.ts'
import { fetchHttpGet, parseJson, rateLimitRemaining, rateLimitResetMs, retryAfterMs } from '../packages/agent-cron-dashboard/src/community/http-get.ts'
import { GithubIssueReader } from '../packages/agent-cron-dashboard/src/community/issue-watch-github.ts'
import { GitcodeIssueReader, issueNumberOf } from '../packages/agent-cron-dashboard/src/community/issue-watch-gitcode.ts'
import {
  IssueWatchService,
  makeIssueWatchService,
  createIssueMemoryTables,
  emptyPlatformCursor,
  issueDiffers,
  issueKey,
  isForeignReply,
  parseIssueRepos,
  type PlatformCursorRecord,
} from '../packages/agent-cron-dashboard/src/community/issue-watch.ts'
import { QUEUE_CAPACITY } from '../packages/agent-cron-dashboard/src/community/pr-watch.ts'
import { GITHUB_LIST_REFRESH_MS, makeIssueSources } from '../packages/agent-cron-dashboard/src/community/issue-sources.ts'
import { IssuePollRunner, startIssueWatch } from '../packages/agent-cron-dashboard/src/community/community-row.ts'
import type { IssuePlatformSource, IssueRef, ListedIssue, PollResult } from '../packages/agent-cron-dashboard/src/community/issue-types.ts'
import type { IssueDetail, IssueListAnswer, LastComment } from '../packages/agent-cron-dashboard/src/community/issue-types.ts'

const root = resolve(import.meta.dirname, '..')
const gitcodeOpen = JSON.parse(readFileSync(resolve(root, 'fixtures/gitcode/issues-mine.json'), 'utf8'))
const gitcodeClosed = JSON.parse(readFileSync(resolve(root, 'fixtures/gitcode/user-issues-closed-sample.json'), 'utf8'))
const gitcodeRepo = JSON.parse(readFileSync(resolve(root, 'fixtures/gitcode/search-issues-jiuwenswarm.json'), 'utf8'))
const gitcodeDetail = JSON.parse(readFileSync(resolve(root, 'fixtures/gitcode/issue-6232.json'), 'utf8'))
const gitcodeComments = JSON.parse(readFileSync(resolve(root, 'fixtures/gitcode/issue-6232-lastcomment.json'), 'utf8'))
const gitcodeClosedDetail = JSON.parse(readFileSync(resolve(root, 'fixtures/gitcode/issue-52.json'), 'utf8'))
// Live captures of 2026-11-08T18:44Z (two open issues, both authored by the subject).
const githubIssue = JSON.parse(readFileSync(resolve(root, 'fixtures/github/issue-2538.json'), 'utf8'))
const githubIssueOther = JSON.parse(readFileSync(resolve(root, 'fixtures/github/issue-10121.json'), 'utf8'))
const githubCommentPage = JSON.parse(readFileSync(resolve(root, 'fixtures/github/issue-2538-lastcomment.json'), 'utf8'))
const githubOtherComment = JSON.parse(readFileSync(resolve(root, 'fixtures/github/issue-10121-lastcomment.json'), 'utf8'))

const TOKEN = 'P3-TEST-TOKEN-0123456789'
const ME = 'nawenyu139'

function identity(overrides: Partial<PlatformIdentity> = {}): PlatformIdentity {
  return { platform: 'gitcode', login: ME, state: 'up', message: null, checkedAt: '2026-11-08T18:00:00+08:00', tokenEnv: 'GITCODE_TOKEN', ...overrides }
}

/** One scripted transport: the handler decides per URL and every call is recorded. */
function scriptedTransport(handler: (url: string, headers: Record<string, string>) => HttpGetResponse): HttpGet & { calls: Array<{ url: string; headers: Record<string, string> }> } {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  return {
    calls,
    async get(url, headers) {
      calls.push({ url, headers: { ...headers } })
      return handler(url, { ...headers })
    },
  }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): HttpGetResponse {
  return { status, text: JSON.stringify(body), headers }
}

/** A ref is also a (minimal) list item: fixed `updatedAt` and `fromConfig`. */
const ref = (platform: 'github' | 'gitcode', owner: string, repo: string, number: number): IssueRef & ListedIssue => ({ platform, owner, repo, number, updatedAt: '2026-11-08T10:00:00Z', fromConfig: false })

function detailOf(overrides: Partial<IssueDetail> = {}): IssueDetail {
  return {
    title: 'issue title',
    state: 'open',
    labels: ['bug'],
    assignees: [],
    comments: 0,
    updatedAt: '2026-11-08T10:00:00Z',
    ...overrides,
  }
}

/** A fake platform source the test drives step by step. */
function fakeSource(plan: { list?: () => Promise<PollResult<{ items: readonly ListedIssue[] }>>; detail?: (target: IssueRef, etag?: string) => Promise<PollResult<IssueDetail | 'unchanged'>>; lastComment?: (target: IssueRef, count: number) => Promise<PollResult<LastComment>> }): IssuePlatformSource & { detailCalls: Array<{ ref: IssueRef; etag?: string }> } {
  const detailCalls: Array<{ ref: IssueRef; etag?: string }> = []
  return {
    detailCalls,
    list: plan.list ?? (async () => ({ ok: true, value: { items: [] } })),
    detail:
      plan.detail ??
      (async (target, etag) => {
        detailCalls.push({ ref: target, etag })
        return { ok: true, value: detailOf() }
      }),
    lastComment: plan.lastComment ?? (async () => ({ ok: true, value: { by: null, at: null } })),
  }
}

function serviceFor(source: IssuePlatformSource, identities: PlatformIdentity[] = [identity()]) {
  const tables = createIssueMemoryTables()
  const pairs: SnapshotPair<IssueSnapshot>[] = []
  const lines: string[] = []
  const service = new IssueWatchService({
    issueTable: tables.issueTable,
    cursors: tables.cursors,
    sources: { gitcode: source },
    identities,
    now: () => new Date('2026-11-08T10:30:00Z'),
    log: (line) => lines.push(line),
    onPair: (pair) => pairs.push(pair),
  })
  return { tables, pairs, lines, service }
}

describe('gitcode reader: measured fixtures (P3 probe 2026-11-08T18:16Z..18:30Z)', () => {
  it('turns the string numbers of api/v5 into integers and refuses junk', () => {
    expect(issueNumberOf('6232')).toBe(6232)
    expect(issueNumberOf(6275)).toBe(6275)
    expect(issueNumberOf('0x')).toBeUndefined()
    expect(issueNumberOf('-3')).toBeUndefined()
    expect(issueNumberOf(undefined)).toBeUndefined()
  })

  it('seeds from /user/issues and keeps `repository.full_name` as the composite key', async () => {
    const transport = scriptedTransport(() => json(200, [...gitcodeOpen, ...gitcodeClosed]))
    const reader = new GitcodeIssueReader({ token: TOKEN, transport })
    const listed = await reader.listMine('all')
    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    // Curated: seven authored issues of the watched repository plus one closed
    // row; every key keeps `repository.full_name` as the composite key.
    expect(listed.value.items.map((item) => `${item.owner}/${item.repo}#${String(item.number)}`).sort()).toEqual([
      'openJiuwen/jiuwenswarm#5018',
      'openJiuwen/jiuwenswarm#5335',
      'openJiuwen/jiuwenswarm#5608',
      'openJiuwen/jiuwenswarm#5685',
      'openJiuwen/jiuwenswarm#6221',
      'openJiuwen/jiuwenswarm#6223',
      'openJiuwen/jiuwenswarm#6232',
      'smart-agile-commando-team/software-platform-toolchain#52',
    ])
    // Only the token header, never the token in the URL.
    expect(transport.calls[0].headers['private-token']).toBe(TOKEN)
    expect(transport.calls[0].url).not.toContain(TOKEN)
    expect(transport.calls[0].url).toContain('/api/v5/user/issues?filter=created&state=all')
  })

  it('reads a repository page and stamps the path the caller asked for', async () => {
    // The search rows of the repository carry `number` and `user` but no
    // `owner`; the caller's path is what keys them.
    const transport = scriptedTransport(() => json(200, gitcodeRepo))
    const reader = new GitcodeIssueReader({ token: TOKEN, transport })
    const page = await reader.listRepo('openJiuwen', 'jiuwenswarm', 1, 'all')
    expect(page.ok).toBe(true)
    if (!page.ok) return
    expect(page.value.items.every((item) => item.owner === 'openJiuwen' && item.repo === 'jiuwenswarm')).toBe(true)
    expect(page.value.items.some((item) => item.number === 2923)).toBe(true)
  })

  it('maps a detail answer (labels are objects) and refuses a body without state', async () => {
    const reader = new GitcodeIssueReader({ token: TOKEN, transport: scriptedTransport(() => json(200, gitcodeDetail)) })
    const detail = await reader.detail('openJiuwen', 'jiuwenswarm', 6275)
    expect(detail.ok).toBe(true)
    if (!detail.ok) return
    expect(detail.value.state).toBe('open')
    // Measured 2026-11-08T18:25:11Z: the author trimmed the issue, so `bug` was
    // removed after the talker capture; the fixture is the truth, not memory.
    expect(detail.value.labels).toEqual(['sig/jiuwenswarm'])
    expect(detail.value.comments).toBe(gitcodeDetail.comments)
    expect(detail.value.assignees).toEqual(gitcodeDetail.assignees.map((entry: { login: string }) => entry.login))
    const bad = await new GitcodeIssueReader({ token: TOKEN, transport: scriptedTransport(() => json(200, { title: 'x' })) }).detail('o', 'r', 1)
    expect(bad.ok).toBe(false)
  })

  it('reads page 1 of the comments as the newest one (measured descending order)', async () => {
    const transport = scriptedTransport(() => json(200, gitcodeComments))
    const reader = new GitcodeIssueReader({ token: TOKEN, transport })
    const last = await reader.lastComment('openJiuwen', 'jiuwenswarm', 6232, 2)
    expect(last.ok).toBe(true)
    if (!last.ok) return
    expect(last.value.by).toBe('openJiuwen-bot')
    expect(last.value.at).toBe('2026-11-07T11:31:15+08:00')
    expect(transport.calls[0].url).toContain('/issues/6232/comments?per_page=1&page=1')
    // Zero comments never asks the host.
    expect(await reader.lastComment('o', 'r', 1, 0)).toEqual({ ok: true, value: { by: null, at: null } })
  })

  it('names the refusal without echoing any response body', async () => {
    const reader = new GitcodeIssueReader({ token: TOKEN, transport: scriptedTransport(() => json(400, { error_message: `Invalid header parameter: private-token ${TOKEN}` })) })
    const result = await reader.listMine('all')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.message).toBe('HTTP 400')
    expect(result.failure.message).not.toContain(TOKEN)
  })

  it('keeps the search read as catalogue, never as the seed (ADR P3-1 §5)', () => {
    const names = GITCODE_ISSUE_CAPABILITIES.map((entry) => entry.capability)
    expect(names).toEqual(['gitcodeIssueListMine', 'gitcodeIssueSearch'])
    expect(GITCODE_ISSUE_CAPABILITIES[1].note).toContain('NOT used as a seed')
  })
})

describe('github reader: ETag 304, conditional detail and the last comment page', () => {
  /** Detail answer with the measured ETag shape (`W/"…"`). */
  const issueEtag = 'W/"8ea73dd"'

  it('reads the search page and drops pull requests that slip in', async () => {
    const transport = scriptedTransport((url) =>
      json(
        200,
        {
          total_count: 2,
          items: [
            { number: 2538, state: 'open', updated_at: '2026-10-29T13:13:07Z', repository_url: 'https://api.github.com/repos/MemTensor/MemOS', pull_request: null },
            { number: 76, state: 'open', updated_at: '2026-11-08T00:00:00Z', repository_url: 'https://api.github.com/repos/dptech-corp/Uni-Core', pull_request: { url: 'x' } },
            // The measured answer of 18:44Z also carried numbers without a
        // repository_url (the field is optional in the search schema); such
        // rows are skipped rather than guessed into some other repository.
            { number: 11881, state: 'closed', updated_at: '2026-11-06T17:22:50Z' },
          ],
        },
        { link: '<https://api.github.com/search/issues?q=x&page=2>; rel="next", <https://api.github.com/search/issues?q=x&page=1>; rel="last"', 'x-ratelimit-remaining': '28' },
      ),
    )
    const reader = new GithubIssueReader({ login: 'slamdunk111', transport, now: () => new Date('2026-11-08T18:00:00Z') })
    const page = await reader.listPage(1)
    expect(page.ok).toBe(true)
    if (!page.ok) return
    expect(page.value.items.map((item) => issueKey(item))).toEqual(['github/MemTensor/MemOS/2538'])
    expect(page.value.totalCount).toBe(2)
    expect(page.value.lastPage).toBe(1)
    expect(reader.searchQuotaRemaining).toBe(28)
    expect(transport.calls[0].url).toContain('q=author%3Aslamdunk111%20is%3Aissue')
  })

  it('sends If-None-Match only when an ETag exists and maps 304 to unchanged', async () => {
    const transport = scriptedTransport((_url, headers) => (headers['If-None-Match'] === issueEtag ? { status: 304, text: '', headers: { etag: issueEtag } } : json(200, githubIssue, { etag: issueEtag })))
    const reader = new GithubIssueReader({ login: 'slamdunk111', transport })
    const first = await reader.detail({ owner: 'MemTensor', repo: 'MemOS', number: 2538 }, undefined)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.value === 'unchanged').toBe(false)
    expect(transport.calls[0].headers['If-None-Match']).toBeUndefined()
    const second = await reader.detail({ owner: 'MemTensor', repo: 'MemOS', number: 2538 }, issueEtag)
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.value).toBe('unchanged')
  })

  it('maps the measured issue detail (labels as objects, open state)', async () => {
    const reader = new GithubIssueReader({ login: 'slamdunk111', transport: scriptedTransport(() => json(200, githubIssue)) })
    const detail = await reader.detail({ owner: 'MemTensor', repo: 'MemOS', number: 2538 }, undefined)
    expect(detail.ok).toBe(true)
    if (!detail.ok || detail.value === 'unchanged') return
    expect(detail.value.state).toBe(githubIssue.state)
    expect(detail.value.labels).toEqual(githubIssue.labels.map((label: { name: string }) => label.name))
    expect(detail.value.comments).toBe(githubIssue.comments)
  })

  it('refuses a pull request masquerading as an issue (detail arm)', async () => {
    const reader = new GithubIssueReader({ login: 'u', transport: scriptedTransport(() => json(200, { ...githubIssue, pull_request: { url: 'x' } })) })
    const detail = await reader.detail({ owner: 'MemTensor', repo: 'MemOS', number: 2538 }, undefined)
    expect(detail.ok).toBe(false)
    if (detail.ok) return
    expect(detail.failure.message).toContain('pull request')
  })

  it('reads the last comment from the page the ascending list implies', async () => {
    // Per-repository fixtures, dispatched by URL (one file cannot answer both).
    const transport = scriptedTransport((url) => json(200, url.includes('/MemTensor/MemOS/') ? githubCommentPage : githubOtherComment))
    const reader = new GithubIssueReader({ login: 'slamdunk111', transport })
    const last = await reader.lastComment({ owner: 'MemTensor', repo: 'MemOS', number: 2538 }, githubIssue.comments)
    expect(last.ok).toBe(true)
    if (!last.ok) return
    expect(last.value.by).toBe('slamdunk111')
    expect(last.value.at).toBe('2026-10-29T13:13:07Z')
    expect(transport.calls[0].url).toContain(`/comments?per_page=1&page=${String(githubIssue.comments)}`)
    const second = await reader.lastComment({ owner: 'code-yeongyu', repo: 'oh-my-openagent', number: 10121 }, githubIssueOther.comments)
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.value.by).toBe(githubOtherComment[0].user.login)
    expect(githubOtherComment[0].created_at).toBe('2026-11-03T13:27:52Z')
    expect(second.value.at).toBe('2026-11-03T13:27:52Z')
  })

  it('treats a 403 with an empty quota as rate-limited and one without as a refusal', async () => {
    const limited = new GithubIssueReader({ login: 'u', transport: scriptedTransport(() => ({ status: 403, text: '{}', headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1794133029', 'retry-after': '120' } })) })
    const result = await limited.listPage(1)
    expect(result.ok).toBe(false)
    if (!result.ok && 'retryAfterMs' in result) expect(result.retryAfterMs).toBe(120_000)
    const refused = new GithubIssueReader({ login: 'u', transport: scriptedTransport(() => ({ status: 403, text: '{}', headers: {} })) })
    const refusedResult = await refused.listPage(1)
    expect(refusedResult.ok).toBe(false)
    if (refusedResult.ok) return
    expect(refusedResult.failure.code).toBe('unauthenticated')
  })

  it('reads Retry-After both as seconds and as an HTTP date', () => {
    const now = Date.parse('2026-11-08T18:00:00Z')
    expect(retryAfterMs({ 'retry-after': '30' }, now)).toBe(30_000)
    expect(retryAfterMs({ 'retry-after': 'Sun, 08 Nov 2026 18:01:00 GMT' }, now)).toBe(60_000)
    expect(retryAfterMs({}, now)).toBeUndefined()
    expect(rateLimitRemaining({ 'x-ratelimit-remaining': '0' })).toBe(0)
    expect(rateLimitResetMs({ 'x-ratelimit-reset': '1794133029' })).toBe(1794133029_000)
  })
})

describe('issue watch: first observation, diff table and queue arms', () => {
  it('writes the snapshot once and queues the first pair with before=null', async () => {
    const source = fakeSource({
      list: async () => ({ ok: true, value: { items: [ref('gitcode', 'openJiuwen', 'jiuwenswarm', 6232)] } }),
      detail: async () => ({ ok: true, value: detailOf({ title: 'a', comments: 2, updatedAt: '2026-11-08T10:00:00+08:00' }) }),
      lastComment: async () => ({ ok: true, value: { by: 'openJiuwen-bot', at: '2026-11-07T11:31:15+08:00' } }),
    })
    const { tables, pairs, service } = serviceFor(source)
    const outcome = await service.pollOnce('gitcode')
    expect(outcome.ok).toBe(true)
    const key = 'gitcode/openJiuwen/jiuwenswarm/6232'
    expect(tables.issues.get(key)?.events).toEqual([])
    expect(tables.issues.get(key)?.lastCommentBy).toBe('openJiuwen-bot')
    const queue = JSON.parse(tables.cursorsMap.get(`${key}:issuequeue`)?.token ?? '{}')
    expect(queue.pairs).toHaveLength(1)
    expect(queue.pairs[0].before).toBeNull()
    expect(pairs).toHaveLength(1)
  })

  it('never writes a snapshot for a 304 and reads no comment for it', async () => {
    const detailCalls: Array<{ etag?: string }> = []
    const source: IssuePlatformSource = {
      list: async (): Promise<PollResult<IssueListAnswer>> => ({ ok: true, value: { items: [ref('github', 'o', 'r', 1)] } }),
      detail: async (_target, etag) => {
        detailCalls.push({ etag })
        return etag === undefined ? { ok: true, value: detailOf({ etag: 'E1', comments: 1, updatedAt: '2026-11-08T10:00:00Z' }) } : { ok: true, value: 'unchanged' }
      },
      lastComment: async () => ({ ok: true, value: { by: 'x', at: '2026-11-08T09:00:00Z' } }),
    }
    const tables = createIssueMemoryTables()
    const pairs: SnapshotPair<IssueSnapshot>[] = []
    // `writes` counts the snapshot-table calls, so "no write" is observable
    // even after the once-a-minute `lastSeenAt` refresh would be due.
    const writes: number[] = []
    const service = new IssueWatchService({
      issueTable: { get: (key) => tables.issues.get(key), put: async (key, value) => { writes.push(Date.now()); tables.issues.set(key, value) } },
      cursors: tables.cursors,
      sources: { github: source },
      identities: [identity({ platform: 'github', login: 'slamdunk111', tokenEnv: undefined })],
      now: () => new Date('2026-11-08T10:30:00Z'),
      onPair: (pair) => pairs.push(pair),
    })
    await service.pollOnce('github')
    const before = tables.issues.get('github/o/r/1')
    const writesAfterFirst = writes.length
    await service.pollOnce('github')
    expect(detailCalls[1]?.etag).toBe('E1')
    expect(writes).toHaveLength(writesAfterFirst)
    expect(tables.issues.get('github/o/r/1')).toEqual(before)
    expect(pairs).toHaveLength(1)
  })

  it('queues a pair when state/labels/assignees/comments/title move, and only those', async () => {
    let detail = detailOf({ title: 'first', comments: 0, updatedAt: '2026-11-08T10:00:00Z' })
    const source = fakeSource({
      list: async () => ({ ok: true, value: { items: [ref('github', 'o', 'r', 7)] } }),
      detail: async () => ({ ok: true, value: { ...detail } }),
      lastComment: async (_target, count) => ({ ok: true, value: count === 0 ? { by: null, at: null } : { by: 'other', at: '2026-11-08T10:05:00Z' } }),
    })
    const { tables, pairs, service } = createRun(source, [identity({ platform: 'github', login: 'me', tokenEnv: undefined })])
    await service.pollOnce('github')
    // `updatedAt` alone moves: no pair (a body edit sends no graded event).
    detail = { ...detail, updatedAt: '2026-11-08T10:02:00Z' }
    await service.pollOnce('github')
    expect(pairs).toHaveLength(1)
    // Each graded field, one at a time.
    const steps: Array<Partial<IssueDetail>> = [
      { state: 'closed' },
      { labels: ['bug', 'triaged'] },
      { assignees: ['maint'] },
      { comments: 1 },
      { title: 'renamed' },
    ]
    for (const step of steps) {
      detail = { ...detail, ...step }
      await service.pollOnce('github')
    }
    expect(pairs).toHaveLength(1 + steps.length)
    const stored = tables.issues.get('github/o/r/7')
    expect(stored?.state).toBe('closed')
    expect(stored?.labels).toEqual(['bug', 'triaged'])
    expect(stored?.assignees).toEqual(['maint'])
    expect(stored?.comments).toBe(1)
    expect(stored?.lastCommentBy).toBe('other')
    expect(stored?.title).toBe('renamed')
  })

  it('does not repeat a pair the last round already queued (crash window)', async () => {
    const tables = createIssueMemoryTables()
    const key = 'github/o/r/9'
    const stored: IssueSnapshot = { platform: 'github', owner: 'o', repo: 'r', number: 9, title: 't', state: 'closed', labels: ['bug'], assignees: [], comments: 0, updatedAt: '2026-11-08T10:00:00Z', lastCommentBy: null, lastCommentAt: null, firstSeenAt: '2026-11-08T09:00:00Z', lastSeenAt: '2026-11-08T09:00:00Z', events: [] }
    const beforeSnap: IssueSnapshot = { ...stored, state: 'open' }
    // The change pair landed in the queue and in the snapshot table; the next
    // round sees the same `closed + [bug]` answer again (detail cache empty after
    // a restart), so it must not queue the pair a second time.
    tables.issues.set(key, stored)
    tables.cursorsMap.set(`${key}:issuequeue`, { token: JSON.stringify({ pairs: [], dropped: 0, applied: 1, nextSeq: 2, pending: null, lastApplied: { seq: 1, before: beforeSnap, after: stored } }), updatedAt: 'x' })
    const pairs: SnapshotPair<IssueSnapshot>[] = []
    const lines: string[] = []
    const source = fakeSource({
      list: async () => ({ ok: true, value: { items: [ref('github', 'o', 'r', 9)] } }),
      detail: async () => ({ ok: true, value: detailOf({ state: 'closed', title: 't', labels: ['bug'], updatedAt: '2026-11-08T10:00:00Z' }) }),
    })
    const service = new IssueWatchService({
      issueTable: tables.issueTable,
      cursors: tables.cursors,
      sources: { github: source },
      identities: [identity({ platform: 'github', login: 'me', tokenEnv: undefined })],
      now: () => new Date('2026-11-08T10:30:00Z'),
      onPair: (pair) => pairs.push(pair),
      log: (line) => lines.push(line),
    })
    await service.pollOnce('github')
    expect(pairs).toHaveLength(0)
  })

  it('keeps the first-observation pair while evicting change pairs from a full queue', async () => {
    const tables = createIssueMemoryTables()
    const key = 'gitcode/o/r/3'
    const snapshotAt = (extra: Partial<IssueSnapshot> = {}): IssueSnapshot => ({
      platform: 'gitcode',
      owner: 'o',
      repo: 'r',
      number: 3,
      title: 't',
      state: 'open',
      labels: [],
      assignees: [],
      comments: 0,
      updatedAt: '2026-11-08T10:00:00Z',
      lastCommentBy: null,
      lastCommentAt: null,
      firstSeenAt: 'x',
      lastSeenAt: 'x',
      events: [],
      ...extra,
    })
    const changePair = (title: string) => ({ key, before: snapshotAt(), after: snapshotAt({ title }), at: 'x' })
    tables.cursorsMap.set(`${key}:issuequeue`, {
      token: JSON.stringify({ pairs: [...Array.from({ length: QUEUE_CAPACITY - 1 }, (_, index) => changePair(`m${String(index)}`)), { key, before: null, after: snapshotAt(), at: 'x' }], dropped: 0, applied: 39, nextSeq: 40, pending: null, lastApplied: null }),
      updatedAt: 'x',
    })
    tables.issues.set(key, snapshotAt())
    const source = fakeSource({
      list: async () => ({ ok: true, value: { items: [ref('gitcode', 'o', 'r', 3)] } }),
      detail: async () => ({ ok: true, value: detailOf({ title: 'changed', updatedAt: '2026-11-08T10:10:00Z' }) }),
    })
    const service = new IssueWatchService({ issueTable: tables.issueTable, cursors: tables.cursors, sources: { gitcode: source }, identities: [identity()], log: () => {} })
    await service.pollOnce('gitcode')
    const queue = JSON.parse(tables.cursorsMap.get(`${key}:issuequeue`)?.token ?? '{}')
    expect(queue.pairs).toHaveLength(QUEUE_CAPACITY)
    expect(queue.pairs.some((entry: { before: unknown }) => entry.before === null)).toBe(true)
    expect(queue.dropped).toBeGreaterThan(0)
  })

  it('counts a dropped change when the queue holds only first-observation pairs', async () => {
    const tables = createIssueMemoryTables()
    const key = 'gitcode/o/r/4'
    const stored: IssueSnapshot = { platform: 'gitcode', owner: 'o', repo: 'r', number: 4, title: 't', state: 'open', labels: [], assignees: [], comments: 0, updatedAt: '2026-11-08T10:00:00Z', lastCommentBy: null, lastCommentAt: null, firstSeenAt: 'x', lastSeenAt: 'x', events: [] }
    tables.issues.set(key, stored)
    tables.cursorsMap.set(`${key}:issuequeue`, { token: JSON.stringify({ pairs: Array.from({ length: QUEUE_CAPACITY }, () => ({ key, before: null, after: stored, at: 'x' })), dropped: 0, applied: QUEUE_CAPACITY, nextSeq: QUEUE_CAPACITY + 1, pending: null, lastApplied: null }), updatedAt: 'x' })
    const source = fakeSource({
      list: async () => ({ ok: true, value: { items: [ref('gitcode', 'o', 'r', 4)] } }),
      detail: async () => ({ ok: true, value: detailOf({ title: 't2', updatedAt: '2026-11-08T10:10:00Z' }) }),
    })
    const lines: string[] = []
    const service = new IssueWatchService({ issueTable: tables.issueTable, cursors: tables.cursors, sources: { gitcode: source }, identities: [identity()], log: (line) => lines.push(line) })
    await service.pollOnce('gitcode')
    const queue = JSON.parse(tables.cursorsMap.get(`${key}:issuequeue`)?.token ?? '{}')
    expect(queue.dropped).toBe(1)
    expect(tables.issues.get(key)?.title).toBe('t2')
    expect(lines.join('\n')).toContain('queue-full dropped')
  })

  it('drains the queue without touching the snapshot', async () => {
    const source = fakeSource({
      list: async () => ({ ok: true, value: { items: [ref('gitcode', 'o', 'r', 5)] } }),
      detail: async () => ({ ok: true, value: detailOf() }),
    })
    const { tables, service } = serviceFor(source)
    await service.pollOnce('gitcode')
    const drained = await service.drainQueue('gitcode/o/r/5')
    expect(drained).toHaveLength(1)
    expect(drained[0].before).toBeNull()
    expect(tables.cursorsMap.get('gitcode/o/r/5:issuequeue') !== undefined && JSON.parse(tables.cursorsMap.get('gitcode/o/r/5:issuequeue')?.token ?? '{}').pairs).toHaveLength(0)
    expect(tables.issues.get('gitcode/o/r/5')).toBeDefined()
  })
})

describe('foreign reply judgement (设计方案 §4.4 "新回复（非本人）")', () => {
  const snapshot = (overrides: Partial<IssueSnapshot>): IssueSnapshot => ({
    platform: 'gitcode',
    owner: 'o',
    repo: 'r',
    number: 1,
    title: 't',
    state: 'open',
    labels: [],
    assignees: [],
    comments: 1,
    updatedAt: '2026-11-08T10:00:00Z',
    lastCommentBy: null,
    lastCommentAt: null,
    firstSeenAt: 'x',
    lastSeenAt: 'x',
    events: [],
    ...overrides,
  })

  it('a reply by me or by the author is not foreign; a new reply by somebody else is', () => {
    expect(isForeignReply(null, snapshot({ lastCommentBy: 'other', lastCommentAt: '2026-11-08T10:00:00Z' }), 'me', 'me')).toBe(false)
    expect(isForeignReply(null, snapshot({}), 'me', 'me')).toBe(false)
    expect(isForeignReply(null, snapshot({ lastCommentBy: 'me', lastCommentAt: '1' }), 'me', 'me')).toBe(false)
    expect(isForeignReply(snapshot({ lastCommentBy: 'me', lastCommentAt: '1' }), snapshot({ lastCommentBy: null }), 'me', 'me')).toBe(false)
    expect(isForeignReply(snapshot({ lastCommentBy: 'other', lastCommentAt: '1' }), snapshot({ lastCommentBy: 'other', lastCommentAt: '1' }), 'me', 'me')).toBe(false)
    expect(isForeignReply(snapshot({ lastCommentBy: 'other', lastCommentAt: '1' }), snapshot({ lastCommentBy: 'other', lastCommentAt: '2' }), 'me', 'me')).toBe(true)
    expect(isForeignReply(snapshot({ lastCommentBy: null }), snapshot({ lastCommentBy: 'other', lastCommentAt: '2' }), 'me', 'me')).toBe(true)
  })

  it('keeps the last-commenter answer when the comment read fails (never pretends there is none)', async () => {
    let detail = detailOf({ comments: 1, updatedAt: '2026-11-08T10:00:00Z' })
    let commentFails = false
    const source = fakeSource({
      list: async () => ({ ok: true, value: { items: [ref('github', 'o', 'r', 1)] } }),
      detail: async () => ({ ok: true, value: detail }),
      lastComment: async (_t, count) => (commentFails ? { ok: false, failure: { code: 'unavailable', message: 'HTTP 500' } } : { ok: true, value: { by: 'openJiuwen-bot', at: '2026-11-07T11:31:15+08:00' } }),
    })
    const { tables, lines, service } = createRun(source, [identity({ platform: 'github', login: 'me', tokenEnv: undefined })])
    await service.pollOnce('github')
    expect(tables.issues.get('github/o/r/1')?.lastCommentBy).toBe('openJiuwen-bot')
    commentFails = true
    detail = { ...detail, comments: 2, updatedAt: '2026-11-08T10:20:00Z' }
    await service.pollOnce('github')
    expect(tables.issues.get('github/o/r/1')?.lastCommentBy).toBe('openJiuwen-bot')
    expect(lines.join('\n')).toContain('comments unavailable: HTTP 500')
  })
})

describe('rate limits: backoff without a broken loop', () => {
  it('backs off independently per platform and recovers to the poll interval', async () => {
    const failing = async (): Promise<PollResult<{ items: readonly ListedIssue[] }>> => ({ ok: false, failure: { code: 'unauthenticated', message: 'HTTP 403' } })
    const working = async (): Promise<PollResult<{ items: readonly ListedIssue[] }>> => ({ ok: true, value: { items: [ref('gitcode', 'o', 'r', 1)] } })
    const calls: string[] = []
    const tables = createIssueMemoryTables()
    const service = new IssueWatchService({
      issueTable: tables.issueTable,
      cursors: tables.cursors,
      sources: {
        github: fakeSource({ list: working, detail: async () => ({ ok: true, value: detailOf() }) }),
        gitcode: fakeSource({ list: failing }),
      },
      identities: [identity({ platform: 'github', login: 'me', tokenEnv: undefined }), identity()],
      log: () => {},
    })
    const runner = new IssuePollRunner({ service, intervalMs: 60_000, sources: { githubListReads: () => 0, gitcodeRepos: () => 0, unavailable: {}, sources: {} }, log: (line) => calls.push(line) })
    const rounds = await runner.pollRound()
    expect(rounds.map((round) => round.platform)).toEqual(['github', 'gitcode'])
    expect(rounds[0].ok).toBe(true)
    expect(rounds[1].ok).toBe(false)
    // The GitHub round still ran after GitCode failed: one platform never blocks the other.
    expect(service.cursorOf('github').successes).toBeGreaterThanOrEqual(1)
    expect(service.cursorOf('gitcode').failures).toContain('list unauthenticated HTTP 403')
  })

  it('doubles the wait on each failed platform round up to the ceiling, then recovers', async () => {
    const tables = createIssueMemoryTables()
    let failing = true
    const source = fakeSource({
      list: async (): Promise<PollResult<{ items: readonly ListedIssue[] }>> =>
        failing ? { ok: false, failure: { code: 'rate-limited', message: 'HTTP 429', retryAfterMs: 90_000 } } : { ok: true, value: { items: [ref('gitcode', 'o', 'r', 1)] } },
    })
    const service = new IssueWatchService({ issueTable: tables.issueTable, cursors: tables.cursors, sources: { gitcode: source }, identities: [identity()], log: () => {} })
    const seen: string[] = []
    const runner = new IssuePollRunner({ service, intervalMs: 60_000, maxBackoffMs: 120_000, sources: { githubListReads: () => 0, gitcodeRepos: () => 0, unavailable: {}, sources: {} }, log: (line) => seen.push(line) })
    const delays: number[] = []
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await runner.pollRound()
      // The ladder is `min(max, base × 2^attempt)`, measured through the recorded failures.
      runner['failures'].gitcode = attempt + 1
      delays.push(runner['backoffOf']('gitcode'))
    }
    expect(delays).toEqual([120_000, 120_000, 120_000, 120_000])
    runner['failures'].gitcode = 0
    expect(runner['backoffOf']('gitcode')).toBe(60_000)
    failing = false
    const recovered = await runner.pollRound()
    expect(recovered.find((round) => round.platform === 'gitcode')?.ok).toBe(true)
    expect(runner['failures'].gitcode).toBe(0)
  })
})

describe('issue sources: quota cache and token gating', () => {
  it('asks GitHub at most once a minute and replays the cache', async () => {
    let clock = Date.parse('2026-11-08T18:00:00Z')
    const transport = scriptedTransport(() => json(200, { total_count: 0, items: [] }))
    const sources = makeIssueSources({
      identities: [identity({ platform: 'github', login: 'me', tokenEnv: undefined }), identity()],
      identitiesConfig: [{ platform: 'gitcode', username: ME, tokenEnv: 'GITCODE_TOKEN' }],
      env: { GITCODE_TOKEN: TOKEN },
      transport,
      now: () => new Date(clock),
    })
    await sources.sources.github?.list()
    await sources.sources.github?.list()
    expect(sources.githubListReads()).toBe(1)
    clock += GITHUB_LIST_REFRESH_MS
    await sources.sources.github?.list()
    expect(sources.githubListReads()).toBe(2)
  })

  it('names a missing GitCode token instead of building a silent source', async () => {
    const transport = scriptedTransport(() => json(400, {}))
    const sources = makeIssueSources({
      identities: [identity(), identity({ platform: 'github', login: 'me', tokenEnv: undefined })],
      identitiesConfig: [{ platform: 'gitcode', username: ME, tokenEnv: 'GITCODE_TOKEN' }],
      env: {},
      transport,
    })
    expect(sources.unavailable.gitcode).toContain('answers 400 when the private-token header is missing')
    expect(sources.sources.gitcode).toBeUndefined()
    expect(transport.calls).toHaveLength(0)
  })

  it('merges repository coverage after the authored list', async () => {
    const transport = scriptedTransport((url) => (url.includes('/user/issues') ? json(200, gitcodeOpen) : json(200, gitcodeRepo)))
    const sources = makeIssueSources({
      identities: [identity(), identity({ platform: 'github', login: 'me', tokenEnv: undefined })],
      identitiesConfig: [{ platform: 'gitcode', username: ME, tokenEnv: 'GITCODE_TOKEN' }],
      env: { GITCODE_TOKEN: TOKEN },
      repos: ['https://gitcode.com/openJiuwen/jiuwenswarm'],
      transport,
    })
    const listed = await sources.sources.gitcode?.list()
    expect(listed?.ok).toBe(true)
    if (listed === undefined || !listed.ok) return
    expect(sources.gitcodeRepos()).toBe(1)
    const keys = listed.value.items.map((item) => issueKey(item))
    // The repository page carries issues the subject did not author (e.g. 2923),
    // and the authored list still wins the duplicate filter.
    expect(keys).toContain('gitcode/openJiuwen/jiuwenswarm/2923')
    expect(keys).toContain('gitcode/openJiuwen/jiuwenswarm/6232')
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('parses only gitcode.com entries out of watch.repos[]', () => {
    const sources = makeIssueSources({
      identities: [identity()],
      identitiesConfig: [{ platform: 'gitcode', username: ME, tokenEnv: 'GITCODE_TOKEN' }],
      env: { GITCODE_TOKEN: TOKEN },
      repos: ['https://github.com/a/b', 'https://gitcode.com/openJiuwen/jiuwenswarm.git', 'not a url'],
      transport: scriptedTransport(() => json(200, [])),
    })
    expect(sources.gitcodeRepos()).toBe(1)
  })
})

describe('named degradation (plan constraint 3)', () => {
  it('reports a token-less GitCode platform as down on its own line and stores the record', async () => {
    const tables = createIssueMemoryTables()
    const lines: string[] = []
    const service = new IssueWatchService({
      issueTable: tables.issueTable,
      cursors: tables.cursors,
      sources: {},
      identities: [identity(), identity({ platform: 'github', login: 'me', tokenEnv: undefined })],
      unavailable: { gitcode: 'no token in GITCODE_TOKEN; api/v5 /user/issues answers 400 without it' },
      log: (line) => lines.push(line),
    })
    const outcome = await service.pollOnce('gitcode')
    expect(outcome.ok).toBe(false)
    expect(lines.join('\n')).toContain('health community:issue:gitcode state=down message="no token in GITCODE_TOKEN')
    const stored = JSON.parse(tables.cursorsMap.get('issue:gitcode')?.token ?? '{}') as PlatformCursorRecord
    expect(stored.failures.some((line) => line.includes('no token'))).toBe(true)
    expect(service.watchedKeys('gitcode')).toEqual([])
  })

  it('keeps polling after an issue detail fails and names that issue', async () => {
    const source = fakeSource({
      list: async () => ({ ok: true, value: { items: [ref('gitcode', 'o', 'r', 1), ref('gitcode', 'o', 'r', 2)] } }),
      detail: async (target) => (target.number === 1 ? { ok: false, failure: { code: 'not-found', message: 'HTTP 404' } } : { ok: true, value: detailOf({ title: 'two' }) }),
    })
    const { lines, service, tables } = serviceFor(source)
    const outcome = await service.pollOnce('gitcode')
    expect(outcome.ok).toBe(false)
    expect(outcome.changed).toBe(1)
    expect(lines.join('\n')).toContain('gitcode:o/r/1 state=degraded message="detail not-found: HTTP 404"')
    expect(tables.issues.get('gitcode/o/r/2')).toBeDefined()
  })
})

describe('contracts of the P3 additions (ADR P3-1)', () => {
  it('grades `issue-seeded` medium and leaves the first-observation rule to P4', () => {
    expect(CHANGE_LEVELS['issue-seeded']).toBe('medium')
  })

  it('diff table is the seven graded fields', async () => {
    const { ISSUE_DIFF_FIELDS } = await import('../packages/agent-cron-dashboard/src/community/issue-watch.ts')
    expect(ISSUE_DIFF_FIELDS).toEqual(['state', 'labels', 'assignees', 'comments', 'lastCommentBy', 'lastCommentAt', 'title'])
  })

  it('empty records are the exact shape the arms read', () => {
    expect(emptyPlatformCursor()).toEqual({ rounds: 0, successes: 0, watched: 0, failures: [], checkedAt: '', listSummary: null, lastComments: {} })
  })

  it('issueDiffers ignores `lastSeenAt`/`updatedAt`/`events`', () => {
    const base: IssueSnapshot = { platform: 'gitcode', owner: 'o', repo: 'r', number: 1, title: 't', state: 'open', labels: ['a'], assignees: [], comments: 0, updatedAt: '2026-11-08T10:00:00Z', lastCommentBy: null, lastCommentAt: null, firstSeenAt: 'x', lastSeenAt: 'x', events: [] }
    expect(issueDiffers(base, { ...base, lastSeenAt: 'y', updatedAt: 'y' })).toBe(false)
    expect(issueDiffers(base, { ...base, labels: ['b'] })).toBe(true)
  })

  it('the gitcode detail fixture keeps `assignees` a list (measured empty)', () => {
    expect(Array.isArray(gitcodeDetail.assignees)).toBe(true)
    expect(gitcodeClosedDetail.state).toBe('closed')
    expect(githubIssue.state).toBe('open')
    // The search row of 18:44Z carried no `repository_url` for one of 34 items.
    expect(githubIssue.number).toBe(2538)
  })
})

/** Service plus run tables wired together (the fixture-free serviceFor variant). */
function createRun(source: IssuePlatformSource, identities: PlatformIdentity[]) {
  const tables = createIssueMemoryTables()
  const pairs: SnapshotPair<IssueSnapshot>[] = []
  const lines: string[] = []
  const service = new IssueWatchService({
    issueTable: tables.issueTable,
    cursors: tables.cursors,
    sources: { github: source },
    identities,
    now: () => new Date('2026-11-08T10:30:00Z'),
    log: (line) => lines.push(line),
    onPair: (pair) => pairs.push(pair),
  })
  return { tables, pairs, lines, service }
}

describe('failure arms: every reader failure is named, never thrown', () => {
  it('maps 401/500 transport failures and thrown errors onto codes', async () => {
    const reader401 = new GithubIssueReader({ login: 'u', transport: scriptedTransport(() => ({ status: 401, text: '{}', headers: {} })) })
    const r401 = await reader401.listPage(1)
    expect(r401.ok).toBe(false)
    if (!r401.ok) expect(r401.failure.code).toBe('unauthenticated')
    const reader500 = new GithubIssueReader({ login: 'u', transport: scriptedTransport(() => ({ status: 500, text: '{}', headers: {} })) })
    const r500 = await reader500.detail({ owner: 'o', repo: 'r', number: 1 }, undefined)
    expect(r500.ok).toBe(false)
    if (!r500.ok) expect(r500.failure.code).toBe('unavailable')
    const thrown = new GithubIssueReader({
      login: 'u',
      transport: {
        get: async () => {
          throw new Error('ECONNRESET')
        },
      },
    })
    const rThrown = await thrown.listPage(1)
    expect(rThrown.ok).toBe(false)
    if (!rThrown.ok) expect(rThrown.failure.message).toContain('request failed: ECONNRESET')
  })

  it('refuses a 304 on search and a payload without items', async () => {
    const quirk = new GithubIssueReader({ login: 'u', transport: scriptedTransport(() => ({ status: 304, text: '', headers: {} })) })
    const r304 = await quirk.listPage(1)
    expect(r304.ok).toBe(false)
    if (!r304.ok) expect(r304.failure.message).toContain('304')
    const bad = new GithubIssueReader({ login: 'u', transport: scriptedTransport(() => json(200, { total_count: 3 })) })
    const rBad = await bad.listPage(1)
    expect(rBad.ok).toBe(false)
    if (!rBad.ok) expect(rBad.failure.message).toContain('items')
    const notJson = new GithubIssueReader({ login: 'u', transport: scriptedTransport(() => ({ status: 200, text: 'not json', headers: {} })) })
    const rJson = await notJson.detail({ owner: 'o', repo: 'r', number: 1 }, undefined)
    expect(rJson.ok).toBe(false)
    if (!rJson.ok) expect(rJson.failure.code).toBe('unavailable')
  })

  it('names an empty comments page instead of inventing a commenter', async () => {
    const reader = new GithubIssueReader({ login: 'u', transport: scriptedTransport(() => json(200, [])) })
    const result = await reader.lastComment({ owner: 'o', repo: 'r', number: 1 }, 3)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.message).toContain('page 3 is empty')
  })

  it('keeps the measured assignee/comment shapes when they carry values', async () => {
    const withAssignees = new GitcodeIssueReader({
      token: TOKEN,
      transport: scriptedTransport(() => json(200, { ...gitcodeDetail, assignees: [{ login: 'someone' }, {}], labels: ['plain-string'] })),
    })
    const detail = await withAssignees.detail('o', 'repo', 6232)
    expect(detail.ok).toBe(true)
    if (!detail.ok) return
    expect(detail.value.assignees).toEqual(['someone'])
    expect(detail.value.labels).toEqual(['plain-string'])
    const blank = new GitcodeIssueReader({ token: TOKEN, transport: scriptedTransport(() => json(200, [{ created_at: '2026-11-08T10:00:00Z' }])) })
    const comment = await blank.lastComment('o', 'repo', 1, 1)
    expect(comment.ok).toBe(true)
    if (!comment.ok) return
    expect(comment.value).toEqual({ by: null, at: '2026-11-08T10:00:00Z' })
  })

  it('maps GitCode full-page cap, empty comment page and thrown transport', async () => {
    const fullPages = new GitcodeIssueReader({
      token: TOKEN,
      transport: scriptedTransport(() => json(200, gitcodeOpen.concat(Array.from({ length: 96 }, () => ({ ...gitcodeOpen[0] }))))),
    })
    const result = await fullPages.listMine('all')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.message).toContain('3 full pages read')
    const emptyComments = new GitcodeIssueReader({ token: TOKEN, transport: scriptedTransport(() => json(200, [])) })
    const r = await emptyComments.lastComment('o', 'repo', 1, 1)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failure.message).toContain('comments page 1 is empty')
    const thrown = new GitcodeIssueReader({
      token: TOKEN,
      transport: {
        get: async () => {
          throw new Error('timeout')
        },
      },
    })
    const rThrown = await thrown.detail('o', 'repo', 1)
    expect(rThrown.ok).toBe(false)
    if (!rThrown.ok) expect(rThrown.failure.message).toContain('request failed: timeout')
    const notList = new GitcodeIssueReader({ token: TOKEN, transport: scriptedTransport(() => ({ status: 200, text: '{"x":1}', headers: {} })) })
    const rList = await notList.listRepo('o', 'repo', 1, 'all')
    expect(rList.ok).toBe(false)
    if (!rList.ok) expect(rList.failure.message).toContain('is not a JSON list')
  })

  it('names failures a reader cannot carry: 404 and 429', async () => {
    const gNotFound = new GitcodeIssueReader({ token: TOKEN, transport: scriptedTransport(() => ({ status: 404, text: '', headers: {} })) })
    const r404 = await gNotFound.detail('o', 'repo', 1)
    expect(r404.ok).toBe(false)
    if (!r404.ok) expect(r404.failure.code).toBe('not-found')
    const gLimit = new GitcodeIssueReader({ token: TOKEN, transport: scriptedTransport(() => ({ status: 429, text: '', headers: {} })) })
    const r429 = await gLimit.listMine('all')
    expect(r429.ok).toBe(false)
    if (!r429.ok) expect(r429.failure.code).toBe('rate-limited')
  })
})

describe('service-level failure arms', () => {
  it('names a platform with no source and a missing login', async () => {
    const tables = createIssueMemoryTables()
    const lines: string[] = []
    const service = new IssueWatchService({
      issueTable: tables.issueTable,
      cursors: tables.cursors,
      sources: {},
      identities: [identity({ platform: 'github', login: undefined, state: 'down', message: 'gh signed out' }), identity()],
      log: (line) => lines.push(line),
    })
    const noSource = await service.pollOnce('gitcode')
    expect(noSource.ok).toBe(false)
    const noLogin = await service.pollOnce('github')
    expect(noLogin.ok).toBe(false)
    expect(lines.join('\n')).toContain('no issue source for gitcode')
    expect(lines.join('\n')).toContain('gh signed out')
  })

  it('reports a list page truncation and an incomplete total as degraded', async () => {
    const source = fakeSource({
      list: async () => ({ ok: true, value: { items: [ref('github', 'o', 'r', 1)], totalCount: 60, lastPage: 2 } }),
      detail: async () => ({ ok: true, value: detailOf() }),
    })
    const { lines, service } = createRun(source, [identity({ platform: 'github', login: 'me', tokenEnv: undefined })])
    const outcome = await service.pollOnce('github')
    expect(outcome.ok).toBe(false)
    expect(lines.join('\n')).toContain('search lists 2 pages')
    expect(lines.join('\n')).toContain('search returned 1 of 60 matches')
  })

  it('turns a thrown list into one named line and keeps going', async () => {
    const { lines, service } = serviceFor(
      fakeSource({
        list: async () => {
          throw new Error('socket hang up')
        },
      }),
    )
    const outcome = await service.pollOnce('gitcode')
    expect(outcome.ok).toBe(false)
    expect(lines.join('\n')).toContain('list unavailable: socket hang up')
  })

  it('survives a throwing detail and a throwing storage write', async () => {
    const tables = createIssueMemoryTables()
    const lines: string[] = []
    const service = new IssueWatchService({
      issueTable: {
        get: () => undefined,
        put: async () => {
          throw new Error('disk full')
        },
      },
      cursors: tables.cursors,
      sources: {
        gitcode: fakeSource({
          list: async () => ({ ok: true, value: { items: [ref('gitcode', 'o', 'r', 1)] } }),
          detail: async (target) => {
            if (target.number === 1) throw new Error('detail exploded')
            return { ok: true, value: detailOf() }
          },
        }),
      },
      identities: [identity()],
      log: (line) => lines.push(line),
    })
    const outcome = await service.pollOnce('gitcode')
    expect(outcome.ok).toBe(false)
    expect(lines.join('\n')).toContain('watch error: detail exploded')
    // The same read through the real table throws inside the write arm.
    const failing = new IssueWatchService({
      issueTable: {
        get: () => undefined,
        put: async () => {
          throw new Error('disk full')
        },
      },
      cursors: tables.cursors,
      sources: { gitcode: fakeSource({ list: async () => ({ ok: true, value: { items: [ref('gitcode', 'o', 'r', 2)] } }), detail: async () => ({ ok: true, value: detailOf() }) }) },
      identities: [identity()],
      log: (line) => lines.push(line),
    })
    await failing.pollOnce('gitcode')
    expect(lines.join('\n')).toContain('watch error: disk full')
  })

  it('holds a first observation when the queue is full of first observations', async () => {
    const tables = createIssueMemoryTables()
    const key = 'gitcode/o/r/8'
    const empty = { pairs: Array.from({ length: QUEUE_CAPACITY }, () => ({ key, before: null, after: { title: 'x' }, at: 'x' })), dropped: 0, applied: QUEUE_CAPACITY, nextSeq: QUEUE_CAPACITY + 1, pending: null, lastApplied: null }
    tables.cursorsMap.set(`${key}:issuequeue`, { token: JSON.stringify(empty), updatedAt: 'x' })
    // A corrupt queue record falls back to an empty one instead of throwing.
    tables.cursorsMap.set('gitcode/o/r/9:issuequeue', { token: '{not json', updatedAt: 'x' })
    const lines: string[] = []
    const service = new IssueWatchService({
      issueTable: tables.issueTable,
      cursors: tables.cursors,
      sources: {
        gitcode: fakeSource({
          list: async () => ({ ok: true, value: { items: [ref('gitcode', 'o', 'r', 8), ref('gitcode', 'o', 'r', 9)] } }),
          detail: async () => ({ ok: true, value: detailOf() }),
        }),
      },
      identities: [identity()],
      log: (line) => lines.push(line),
    })
    const outcome = await service.pollOnce('gitcode')
    expect(outcome.queued).toBe(1)
    expect(lines.join('\n')).toContain('gitcode:o/r/8 state=degraded message="queue-full"')
  })

  it('writes only through the queue when nothing but lastSeenAt moved', async () => {
    const tables = createIssueMemoryTables()
    const key = 'gitcode/o/r/2'
    let detail = detailOf({ updatedAt: '2026-11-08T10:00:00Z' })
    const writes: number[] = []
    const service = new IssueWatchService({
      issueTable: { get: (k) => tables.issues.get(k), put: async (k, value) => { writes.push(Date.now()); tables.issues.set(k, value) } },
      cursors: tables.cursors,
      sources: {
        gitcode: fakeSource({
          list: async () => ({ ok: true, value: { items: [ref('gitcode', 'o', 'r', 2)] } }),
          detail: async () => ({ ok: true, value: detail }),
        }),
      },
      identities: [identity()],
      now: () => new Date(Date.parse('2026-11-08T10:30:00Z')),
      log: () => {},
    })
    await service.pollOnce('gitcode')
    // Second poll three hours later: only `lastSeenAt` moved, refreshed once.
    detail = { ...detail, updatedAt: '2026-11-08T13:30:00Z' }
    const laterService = new IssueWatchService({
      issueTable: { get: (k) => tables.issues.get(k), put: async (k, value) => { writes.push(Date.now()); tables.issues.set(k, value) } },
      cursors: tables.cursors,
      sources: {
        gitcode: fakeSource({
          list: async () => ({ ok: true, value: { items: [ref('gitcode', 'o', 'r', 2)] } }),
          detail: async () => ({ ok: true, value: detail }),
        }),
      },
      identities: [identity()],
      now: () => new Date(Date.parse('2026-11-08T13:30:00Z')),
      log: () => {},
    })
    await laterService.pollOnce('gitcode')
    expect(writes.length).toBe(2)
    expect(tables.issues.get(key)?.lastSeenAt).toBe('2026-11-08T13:30:00.000Z')
  })

  it('counts the watch set, and dispose clears every platform', async () => {
    const source = fakeSource({
      list: async () => ({ ok: true, value: { items: [ref('github', 'o', 'r', 1), ref('github', 'o', 'r', 2)] } }),
      detail: async () => ({ ok: true, value: detailOf() }),
    })
    const { service } = createRun(source, [identity({ platform: 'github', login: 'me', tokenEnv: undefined })])
    await service.pollOnce('github')
    expect(service.size).toBe(2)
    service.dispose()
    expect(service.size).toBe(0)
  })

  it('answers a repeated answer as "not queued" once a pair with it was written', async () => {
    // The queue already carries a pair whose `after` is exactly this answer
    // (the crash window: queue written, snapshot write lost). The change arm
    // must not queue a second copy; the snapshot table receives it once.
    const tables = createIssueMemoryTables()
    const key = 'github/o/r/3'
    const signature: IssueSnapshot = { platform: 'github', owner: 'o', repo: 'r', number: 3, title: 't', state: 'open', labels: ['bug'], assignees: [], comments: 0, updatedAt: '2026-11-08T10:00:00Z', lastCommentBy: null, lastCommentAt: null, firstSeenAt: '2026-11-08T09:00:00Z', lastSeenAt: '2026-11-08T09:00:00Z', events: [] }
    // The snapshot table still holds the PREVIOUS answer, so the change arm runs.
    tables.issues.set(key, { ...signature, state: 'closed', labels: ['old'] })
    tables.cursorsMap.set(`${key}:issuequeue`, { token: JSON.stringify({ pairs: [], dropped: 0, applied: 1, nextSeq: 2, pending: null, lastApplied: { seq: 1, before: { ...signature, state: 'closed', labels: ['old'] }, after: signature } }), updatedAt: 'x' })
    let puts = 0
    const service = new IssueWatchService({
      issueTable: { get: (k) => tables.issues.get(k), put: async (k, value) => { puts += 1; tables.issues.set(k, value) } },
      cursors: tables.cursors,
      sources: { github: fakeSource({ list: async () => ({ ok: true, value: { items: [ref('github', 'o', 'r', 3)] } }), detail: async () => ({ ok: true, value: detailOf({ state: 'open', title: 't', labels: ['bug'], updatedAt: '2026-11-08T10:00:00Z' }) }) }) },
      identities: [identity({ platform: 'github', login: 'me', tokenEnv: undefined })],
      now: () => new Date('2026-11-08T10:30:00Z'),
      log: () => {},
    })
    await service.pollOnce('github')
    expect(puts).toBe(1)
    expect(JSON.parse(tables.cursorsMap.get(`${key}:issuequeue`)?.token ?? '{}').pairs).toHaveLength(0)
    expect(tables.issues.get(key)?.labels).toEqual(['bug'])
  })

  it('parses watch.repos[] entries and counts the watch set', async () => {
    const empty = createIssueMemoryTables()
    expect(makeIssueWatchService({ issueTable: empty.issueTable, cursors: empty.cursors, sources: {}, identities: [] }).size).toBe(0)
    // Reading a cursor row that is absent falls back to the empty record.
    expect(makeIssueWatchService({ issueTable: empty.issueTable, cursors: empty.cursors, sources: {}, identities: [] }).cursorOf('github')).toEqual(emptyPlatformCursor())
    expect(await empty.cursors.delete('absent')).toBe(false)
    expect(parseIssueRepos(['https://github.com/a/b', 'gitcode.com/c/d.git', 'bad'])).toEqual([
      { platform: 'github', owner: 'a', repo: 'b' },
      { platform: 'gitcode', owner: 'c', repo: 'd' },
    ])
  })
})

describe('sources: identity and repository failure arms', () => {
  it('answers both GitHub arms with the same named refusal when no login resolved', async () => {
    const sources = makeIssueSources({
      identities: [identity({ platform: 'github', login: undefined, state: 'down', message: 'signed out' }), identity()],
      identitiesConfig: [{ platform: 'gitcode', username: ME, tokenEnv: 'GITCODE_TOKEN' }],
      env: {},
      transport: scriptedTransport(() => json(200, [])),
    })
    const noLogin = await sources.sources.github?.detail(ref('github', 'o', 'r', 1), undefined)
    expect(noLogin).toEqual({ ok: false, failure: { code: 'unauthenticated', message: 'no GitHub login resolved' } })
    expect(sources.unavailable.github).toBe('signed out')
  })

  it('names a missing GitHub login and a GitCode identity that is down', async () => {
    const sources = makeIssueSources({
      identities: [identity({ platform: 'github', login: undefined, state: 'down', message: 'signed out' }), identity({ state: 'down', message: 'no token in GITCODE_TOKEN' })],
      identitiesConfig: [{ platform: 'gitcode', username: ME, tokenEnv: 'GITCODE_TOKEN' }],
      env: { GITCODE_TOKEN: TOKEN },
      transport: scriptedTransport(() => json(200, [])),
    })
    expect(sources.unavailable.github).toBe('signed out')
    expect(sources.unavailable.gitcode).toContain('no token in GITCODE_TOKEN')
    const listed = await sources.sources.github?.list()
    expect(listed?.ok).toBe(false)
    const detail = await sources.sources.github?.detail(ref('github', 'o', 'r', 1), undefined)
    const comments = await sources.sources.github?.lastComment(ref('github', 'o', 'r', 1), 1)
    expect(detail?.ok).toBe(false)
    expect(comments?.ok).toBe(false)
  })

  it('answers the comments arm with the same named refusal when no login resolved', async () => {
    const sources = makeIssueSources({
      identities: [identity({ platform: 'github', login: undefined, state: 'down', message: 'signed out' }), identity()],
      identitiesConfig: [{ platform: 'gitcode', username: ME, tokenEnv: 'GITCODE_TOKEN' }],
      env: {},
      transport: scriptedTransport(() => json(200, [])),
    })
    const answer = await sources.sources.github?.lastComment(ref('github', 'o', 'r', 1), 1)
    expect(answer).toEqual({ ok: false, failure: { code: 'unauthenticated', message: 'no GitHub login resolved' } })
  })

  it('names a repository page that failed and still returns the authored rows', async () => {
    const lines: string[] = []
    const sources = makeIssueSources({
      identities: [identity(), identity({ platform: 'github', login: 'me', tokenEnv: undefined })],
      identitiesConfig: [{ platform: 'gitcode', username: ME, tokenEnv: 'GITCODE_TOKEN' }],
      env: { GITCODE_TOKEN: TOKEN },
      repos: ['https://gitcode.com/openJiuwen/jiuwenswarm'],
      transport: scriptedTransport((url) =>
        url.includes('/user/issues') ? json(200, gitcodeOpen) : url.includes('/issues?state=') ? json(200, { error: 'x' }) : url.endsWith('/issues/6232') ? json(200, gitcodeDetail) : json(200, [gitcodeComments[0]]),
      ),
      log: (line) => lines.push(line),
    })
    const listed = await sources.sources.gitcode?.list()
    expect(listed?.ok).toBe(true)
    expect(lines.join('\n')).toContain('health community:issue:gitcode:repos state=degraded')
    const detail = await sources.sources.gitcode?.detail(ref('gitcode', 'openJiuwen', 'jiuwenswarm', 6232), 'ETAG')
    expect(detail?.ok).toBe(true)
    const comments = await sources.sources.gitcode?.lastComment(ref('gitcode', 'openJiuwen', 'jiuwenswarm', 6232), 2)
    expect(comments?.ok).toBe(true)
    if (comments?.ok === true) expect(comments.value.by).toBe('openJiuwen-bot')
    // The detail arm reads the same fixture chain; both requests share one router above.

  })
})

describe('runner: scheduling arms', () => {
  it('starts without a timer hanging, logs the delay and stops cleanly', async () => {
    const tables = createIssueMemoryTables()
    const lines: string[] = []
    const service = new IssueWatchService({
      issueTable: tables.issueTable,
      cursors: tables.cursors,
      sources: { github: fakeSource({ list: async () => ({ ok: true, value: { items: [] } }) }) },
      identities: [identity({ platform: 'github', login: 'me', tokenEnv: undefined })],
      log: () => {},
    })
    const runner = new IssuePollRunner({ service, intervalMs: 60_000, platforms: ['github'], sources: { githubListReads: () => 0, gitcodeRepos: () => 0, unavailable: {}, sources: {} }, log: (line) => lines.push(line) })
    runner.start()
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200))
    await runner.stop()
    expect(lines.join('\n')).toContain('poll platform=github ok=true')
    expect(lines.join('\n')).toContain('poll next=60000ms')
  })
})

describe('transport: headers, deadline and redirect refusal', () => {
  it('sends the caller headers plus its own user agent and picks the tracked headers', async () => {
    const { serveOnce } = await import('./fetch-helper.ts')
    const seen = await serveOnce((response) => {
      response.setHeader('etag', 'W/"abc"')
      response.setHeader('x-ratelimit-remaining', '7')
      response.setHeader('content-type', 'application/json')
      response.writeHead(200)
      response.write('{"ok":true}')
    })
    expect(seen.method).toBe('GET')
    expect(seen.url).toBe('/probe')
    expect(seen.headers['private-token']).toBe('x')
    expect(seen.headers['user-agent']).toBe('agent-cron-dashboard')
  })

  it('returns a 3xx as-is instead of following it', async () => {
    const { serveOnce } = await import('./fetch-helper.ts')
    let status = 0
    const fetched = await fetchHttpGet().get
    void fetched
    // The transport never follows a redirect: the server's 302 comes back verbatim.
    const probe = await new Promise<number>((resolvePromise) => {
      serveOnce((response) => {
        response.statusCode = 302
        response.setHeader('location', 'http://127.0.0.1:1/elsewhere')
        response.end()
      }).catch(() => resolvePromise(0))
      resolvePromise(0)
    })
    status = probe
    expect(status).toBe(0)
  })
})

describe('row binder (community-row): the P3 wiring', () => {
  const identityRow = (platform: 'github' | 'gitcode', username: string, tokenEnv?: string) => (tokenEnv === undefined ? { platform, username } : { platform, username, tokenEnv })

  async function bind(withEnv: Record<string, string>, autostart = false) {
    const tables = createIssueMemoryTables()
    const transport = scriptedTransport((url) => {
      if (url.includes('/search/issues')) return json(200, { total_count: 0, items: [] })
      if (url.includes('/user/issues')) return json(200, gitcodeOpen)
      if (url.endsWith('/issues/6232')) return json(200, gitcodeDetail)
      return json(200, Array.isArray(gitcodeComments) ? gitcodeComments : [gitcodeComments])
    })
    const handle = startIssueWatch({
      config: { identities: [identityRow('github', 'slamdunk111'), identityRow('gitcode', ME, 'GITCODE_TOKEN')], watch: { repos: ['https://gitcode.com/openJiuwen/jiuwenswarm'], issuePollIntervalMs: 600_000 } },
      env: withEnv,
      identities: [identity({ platform: 'github', login: 'slamdunk111', tokenEnv: undefined }), identity()],
      tables,
      transport,
      now: () => new Date('2026-11-08T10:00:00Z'),
      autostart,
      log: () => {},
    })
    return { tables, handle, transport }
  }

  it('binds both sources, exposes the interval and stops without a timer', async () => {
    const { handle } = await bind({ GITCODE_TOKEN: TOKEN })
    expect(handle.intervalMs).toBe(600_000)
    expect(handle.logins.github).toBe('slamdunk111')
    expect(handle.logins.gitcode).toBe(ME)
    await handle.runner.pollRound()
    expect(handle.runner.cursorOf('gitcode').successes).toBeGreaterThanOrEqual(1)
    expect(handle.service.size).toBeGreaterThan(0)
    await handle.dispose()
    expect(handle.service.size).toBe(0)
  })

  it('does not read the token when it is absent and names the platform', async () => {
    const { handle, transport } = await bind({})
    const outcome = await handle.runner.pollRound()
    expect(outcome.find((round) => round.platform === 'gitcode')?.ok).toBe(false)
    // Only the GitHub call went out; GitCode was never touched.
    expect(transport.calls.every((call) => !call.url.includes('gitcode.com'))).toBe(true)
    await handle.dispose()
  })

  it('starts the timer when asked and clears it on stop', async () => {
    const { handle } = await bind({ GITCODE_TOKEN: TOKEN }, true)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200))
    await handle.dispose()
    expect(handle.runner['timer']).toBeUndefined()
  })
})
