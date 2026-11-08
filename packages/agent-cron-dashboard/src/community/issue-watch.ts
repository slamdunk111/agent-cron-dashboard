/**
 * Issue poller (P3, plan tasks 3–5).
 *
 * One platform loop shape for both hosts: **list → new issues → detail →
 * comments**, then store a snapshot per issue and a snapshot pair for P4 in the
 * same shape as the PR watch (ADR P2-1, ADR P3-1):
 *
 * - `workbench_snapshot_issue` key `<platform>/<owner>/<repo>/<number>`, written
 *   only when a compared field moved (`events` always `[]` until P4 grades).
 * - `workbench_cursors` key `<platform>/<owner>/<repo>/<number>:issuequeue`
 *   holds the pair queue (`QUEUE_CAPACITY` pairs), its drop/applied counters
 *   and the `pending` first-observation marker exactly like the PR queue.
 * - `workbench_cursors` key `issue:github` / `issue:gitcode` holds the round
 *   bookkeeping: round count, successes, the platform-level failure lines
 *   (name + code), the GitCode seed summary and the last comment seen for
 *   "somebody else replied" (the first stage of the §4.4 rule).
 *
 * Which fields are compared (plan §4.4/设计方案 §4.3):
 * `state`, `labels` (sorted), `assignees` (sorted), `comments`, `lastCommentBy`,
 * `lastCommentAt`, `title`. `updatedAt` alone is not a change: an edited body
 * bumps it, and the four graded kinds cannot see a body edit.
 *
 * Nothing here throws: every failure becomes a `health …` line with a named
 * code, and a missing token on GitCode is a `down` identity (identity.ts
 * already says so) that this service repeats on its own line instead of
 * silently watching nothing (plan constraint 3).
 */
import type { SnapshotPair } from '../../../../contracts/events.ts'
import type { IssueSnapshot } from '../../../../contracts/records.ts'
import { QUEUE_CAPACITY } from './pr-watch.ts'
import type { Platform, PlatformIdentity } from './identity.ts'
import { effectiveLogin } from './identity.ts'
import type { IssueDetail, IssueListAnswer, IssuePlatformSource, IssueRef, LastComment, ListedIssue, PollResult } from './issue-types.ts'

export type { IssuePlatformSource } from './issue-types.ts'

/** Minimal table surface of `workbench_snapshot_issue`. */
export interface IssueTable {
  get(key: string): IssueSnapshot | undefined
  put(key: string, value: IssueSnapshot): Promise<void>
}

/** Minimal table surface of `workbench_cursors`. */
export interface CursorTable {
  get(key: string): { readonly token: string; readonly updatedAt: string } | undefined
  put(key: string, value: { readonly token: string; readonly updatedAt: string }): Promise<void>
  delete(key: string): Promise<boolean>
}

/** Pair queue stored at `<key>:issuequeue` (same arms as the PR queue). */
export interface IssueQueueRecord {
  readonly pairs: ReadonlyArray<SnapshotPair<IssueSnapshot>>
  readonly dropped: number
  readonly applied: number
  readonly nextSeq: number
  readonly pending: { readonly seq: number; readonly snapshot: IssueSnapshot; readonly at: string; readonly retries: number } | null
  readonly lastApplied: { readonly seq: number; readonly before: IssueSnapshot; readonly after: IssueSnapshot } | null
}

/** One platform's bookkeeping, stored at `issue:<platform>`. */
export interface PlatformCursorRecord {
  /** Rounds this platform completed (a started round counts even when it failed). */
  readonly rounds: number
  /** Rounds that produced at least one answer. */
  readonly successes: number
  /** Issues in the watch set. */
  readonly watched: number
  /** Every distinct failure line this platform produced (`stage code message`). */
  readonly failures: readonly string[]
  /** ISO 8601 of the last round that finished. */
  readonly checkedAt: string
  /** GitCode seed summary (`/user/issues` rows and repo coverage), null for GitHub. */
  readonly listSummary: string | null
  /** Last comment seen per key; drives "not a new reply by somebody else". */
  readonly lastComments: Readonly<Record<string, { readonly by: string | null; readonly at: string | null }>>
}

/** Options of {@link IssueWatchService}. */
export interface IssueWatchOptions {
  readonly issueTable: IssueTable
  readonly cursors: CursorTable
  /** Readers by platform; a missing platform is named, never silently skipped. */
  readonly sources: Partial<Record<NonNullable<Platform>, IssuePlatformSource>>
  /** Resolved identities (GitHub `gh`-discovered, GitCode token-checked). */
  readonly identities: readonly PlatformIdentity[]
  readonly now?: () => Date
  readonly log?: (line: string) => void
  /** P4 hook; absent means the queue is only persisted. */
  readonly onPair?: (pair: SnapshotPair<IssueSnapshot>) => void
  /** Why a platform is unusable before polling (missing token, no login); shown verbatim. */
  readonly unavailable?: Partial<Record<NonNullable<Platform>, string>>
  /** Repository URL entries from `watch.repos[]` (GitCode optional coverage). */
  readonly repos?: readonly string[]
  /** Issues whose detail read skips older entries once the budget is spent (round shape of plan §3). */
  readonly maxDetailPerRound?: number
  /** Reads in flight per platform within one round (default 2; GitCode sends no rate-limit header). */
  readonly readConcurrency?: number
}

/** Diffed fields (see the module comment for why `updatedAt` is not one). */
export const ISSUE_DIFF_FIELDS = ['state', 'labels', 'assignees', 'comments', 'lastCommentBy', 'lastCommentAt', 'title'] as const

/** Key used by both tables. */
export function issueKey(ref: IssueRef): string {
  return `${ref.platform}/${ref.owner}/${ref.repo}/${ref.number}`
}

/** Empty pair queue for a key. */
export function emptyIssueQueue(): IssueQueueRecord {
  return { pairs: [], dropped: 0, applied: 0, nextSeq: 1, pending: null, lastApplied: null }
}

/** Empty platform bookkeeping. */
export function emptyPlatformCursor(): PlatformCursorRecord {
  return { rounds: 0, successes: 0, watched: 0, failures: [], checkedAt: '', listSummary: null, lastComments: {} }
}

function readJson<T>(row: { readonly token: string } | undefined, fallback: T): T {
  if (row === undefined) return fallback
  try {
    return JSON.parse(row.token) as T
  } catch {
    return fallback
  }
}

function readQueue(cursors: CursorTable, key: string): IssueQueueRecord {
  const parsed = readJson<Partial<IssueQueueRecord>>(cursors.get(`${key}:issuequeue`), {})
  return { ...emptyIssueQueue(), ...parsed, pairs: parsed.pairs ?? [] }
}

/** Repository URL entry (`github.com/o/r` / `gitcode.com/o/r`), tolerant of the scheme and `.git`. */
export function parseIssueRepos(urls: readonly string[]): Array<{ platform: NonNullable<Platform>; owner: string; repo: string }> {
  const out: Array<{ platform: NonNullable<Platform>; owner: string; repo: string }> = []
  for (const url of urls) {
    // The name group is greedy and may swallow the `.git` suffix; strip it the
    // way `seeding.parseRepo` does.
    const match = /^(?:https?:\/\/)?(github\.com|gitcode\.com)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.trim())
    if (match === null) continue
    out.push({ platform: match[1] === 'github.com' ? 'github' : 'gitcode', owner: match[2], repo: match[3] })
  }
  return out
}

/** Whether two stored snapshots differ in a graded field. */
export function issueDiffers(before: IssueSnapshot, after: IssueSnapshot): boolean {
  // Signature, not `ISSUE_DIFF_FIELDS.map(...)`: the list above is the readable
  // form the plan cites, and this function must compare exactly it.
  return issueDiffSignature(before) !== issueDiffSignature(after)
}

/**
 * Whether a reply arrived from somebody other than the issue's author and the
 * polling account itself. This is the measured stage of the §4.4 rule
 * "新回复（非本人）"; the event kind is still P4's to make.
 */
export function isForeignReply(before: IssueSnapshot | null, after: IssueSnapshot, me: string, author: string | null): boolean {
  if (after.lastCommentBy === null || after.lastCommentBy === '') return false
  if (after.lastCommentBy === me) return false
  if (after.lastCommentBy === author) return false
  if (before === null) return false
  return before.lastCommentBy !== after.lastCommentBy || before.lastCommentAt !== after.lastCommentAt
}

export class IssueWatchService {
  private readonly options: IssueWatchOptions
  private readonly log: (line: string) => void
  private readonly cursors$ = new Map<string, PlatformCursorRecord>()
  private readonly watched: Partial<Record<NonNullable<Platform>, Set<string>>> = {}
  /** `updated_at` and ETag of the last detail read per key (the round cache). */
  private readonly cache = new Map<string, { updatedAt: string; etag?: string; lastCommentBy: string | null; lastCommentAt: string | null }>()

  constructor(options: IssueWatchOptions) {
    this.options = options
    this.log = options.log ?? ((line: string) => console.log(line))
  }

  private nowIso(): string {
    return (this.options.now ?? (() => new Date()))().toISOString()
  }

  /** Number of issues in the watch set across platforms. */
  get size(): number {
    return Object.values(this.watched).reduce((sum, set) => sum + (set?.size ?? 0), 0)
  }

  /** Watched keys of one platform (the gate counts them per platform). */
  watchedKeys(platform: NonNullable<Platform>): string[] {
    return [...(this.watched[platform] ?? new Set<string>())]
  }

  /** Bookkeeping of one platform as the last completed round stored it. */
  cursorOf(platform: NonNullable<Platform>): PlatformCursorRecord {
    return this.cursors$.get(platform) ?? emptyPlatformCursor()
  }

  /**
   * Poll one platform once.
   * @returns `{ ok, failures, considered, failures }`-shaped summary for the runner.
   */
  async pollOnce(platform: NonNullable<Platform>): Promise<{ ok: boolean; considered: number; changed: number; queued: number }> {
    const unavailable = this.options.unavailable?.[platform]
    const login = effectiveLogin(this.options.identities, platform)
    if (unavailable !== undefined || login === undefined) {
      const why = unavailable ?? `identity unavailable (${this.options.identities.find((entry) => entry.platform === platform)?.message ?? 'no identity'})`
      const cursor = this.bumpFailure(platform, `identity unavailable ${why}`)
      this.log(`health community:issue:${platform} state=down message="${why}"`)
      await this.writePlatform(platform, cursor)
      return { ok: false, considered: 0, changed: 0, queued: 0 }
    }
    const source = this.options.sources[platform]
    if (source === undefined) {
      const cursor = this.bumpFailure(platform, `no issue source for ${platform}`)
      this.log(`health community:issue:${platform} state=down message="no issue source for ${platform}"`)
      await this.writePlatform(platform, cursor)
      return { ok: false, considered: 0, changed: 0, queued: 0 }
    }
    let cursor: PlatformCursorRecord = { ...this.cursorOf(platform), rounds: this.cursorOf(platform).rounds + 1 }
    this.log(`round#${String(cursor.rounds)} platform=${platform} issues=${String((this.watched[platform] ?? new Set<string>()).size)}`)
    const set = (this.watched[platform] ??= new Set<string>())
    let ok = true
    let consideredInRound = 0
    let changed = 0
    let queued = 0

    // ---- list ----------------------------------------------------------------
    let listed: readonly ListedIssue[] = []
    let listSummary = cursor.listSummary
    try {
      const result = await source.list()
      if (!result.ok) {
        ok = false
        cursor = this.bumpFailureRecord(cursor, `list ${result.failure.code} ${result.failure.message}`)
        this.log(`health community:issue:${platform} state=degraded message="list ${result.failure.code}: ${result.failure.message}"`)
      } else {
        const answer = result.value
        listed = answer.items
        if (platform === 'github' && answer.lastPage !== undefined && answer.lastPage > 1) {
          ok = false
          this.log(`health community:issue:${platform} state=degraded message="search lists ${String(answer.lastPage)} pages; older issues are not enumerated"`)
          cursor = this.bumpFailureRecord(cursor, `list pages ${String(answer.lastPage)}`)
        }
        if (platform === 'github' && answer.totalCount !== undefined && answer.items.length < answer.totalCount) {
          ok = false
          this.log(`health community:issue:${platform} state=degraded message="search returned ${String(answer.items.length)} of ${String(answer.totalCount)} matches"`)
          cursor = this.bumpFailureRecord(cursor, `list truncated ${String(answer.items.length)}/${String(answer.totalCount)}`)
        }
        listSummary =
          platform === 'gitcode'
            ? `seed ${String(answer.items.length)} issue(s) from /user/issues`
            : null
      }
    } catch (error) {
      ok = false
      const message = error instanceof Error ? error.message : String(error)
      cursor = this.bumpFailureRecord(cursor, `list unavailable ${message}`)
      this.log(`health community:issue:${platform} state=degraded message="list unavailable: ${message}"`)
    }
    // The watch set is "everything the list said"; an issue that vanished from
    // the list stays watched only if a previous round put it there and the
    // list still answers (a host cannot un-author an issue, a list failure can).
    if (listed.length > 0) {
      for (const item of listed) set.add(issueKey(item))
    }

    // ---- detail + comments ---------------------------------------------------
    const keys = [...set].map((key) => keyOfKey(key))
    const budget = this.options.maxDetailPerRound ?? Number.POSITIVE_INFINITY
    // Same-platform subjects are read two at a time: GitCode sends no
    // rate-limit header and each read is ~0.3-0.6 s, so a sequential pass over
    // 61 open issues would not fit the window; different platforms never share
    // a batch (their hosts are independent).
    const batchSize = this.options.readConcurrency ?? 2
    const batches: IssueRef[][] = []
    for (const target of keys.slice(0, budget)) {
      const last = batches[batches.length - 1]
      if (last === undefined || last.length >= batchSize || last[0].platform !== target.platform) batches.push([target])
      else last.push(target)
    }
    for (const batch of batches) {
      const outcomes = await Promise.all(
        batch.map(async (ref) => {
          const key = issueKey(ref)
          const cached = this.cache.get(key)
          const failureLines: string[] = []
          const step = { ok: true, considered: 0, changed: 0, queued: 0 }
          let commentCursor: { by: string | null; at: string | null } | undefined
          try {
            const detailResult = await source.detail(ref, cached?.etag)
            if ('failure' in detailResult) {
              step.ok = false
              failureLines.push(`detail ${detailResult.failure.code} ${detailResult.failure.message}`)
              this.log(`health community:issue:${platform}:${ref.owner}/${ref.repo}/${String(ref.number)} state=degraded message="detail ${detailResult.failure.code}: ${detailResult.failure.message}"`)
            } else {
              const stored = this.options.issueTable.get(key)
              if (detailResult.value === 'unchanged' && stored !== undefined) {
                // 304: the host says the answer did not move, so every graded
                // field (ETag coverage) is unchanged by definition; no write, no
                // comment read.
              } else if (detailResult.value !== 'unchanged') {
                const detail = detailResult.value
                step.considered += 1
                const previousCache = this.cache.get(key)
                let lastComment: LastComment | undefined
                const commentsMoved = stored === undefined ? detail.comments > 0 : detail.comments !== stored.comments || (previousCache !== undefined && previousCache.updatedAt !== detail.updatedAt)
                if (commentsMoved && detail.comments > 0) {
                  const commentResult = await source.lastComment(ref, detail.comments)
                  if (commentResult.ok) {
                    lastComment = commentResult.value
                  } else {
                    step.ok = false
                    this.log(`health community:issue:${platform}:${ref.owner}/${ref.repo}/${String(ref.number)} state=degraded message="comments ${commentResult.failure.code}: ${commentResult.failure.message}"`)
                    // Keep the previous answer rather than pretending there is none.
                    if (stored !== undefined) lastComment = { by: stored.lastCommentBy, at: stored.lastCommentAt }
                  }
                } else if (detail.comments === 0) {
                  lastComment = { by: null, at: null }
                } else if (stored !== undefined) {
                  lastComment = { by: stored.lastCommentBy, at: stored.lastCommentAt }
                }
                const after = this.buildSnapshot(ref, detail, lastComment, stored)
                const pair = await this.apply(ref, stored, after, detail)
                if (pair !== null) {
                  step.changed += 1
                  if (pair.queued) step.queued += 1
                }
                this.cache.set(key, { updatedAt: detail.updatedAt, etag: detail.etag, lastCommentBy: after.lastCommentBy, lastCommentAt: after.lastCommentAt })
                commentCursor = { by: after.lastCommentBy, at: after.lastCommentAt }
              }
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            step.ok = false
            this.log(`health community:issue:${platform}:${ref.owner}/${ref.repo}/${String(ref.number)} state=degraded message="watch error: ${message}"`)
          }
          return { ref, key, step, failureLines, commentCursor }
        }),
      )
      for (const outcome of outcomes) {
        consideredInRound += outcome.step.considered
        changed += outcome.step.changed
        queued += outcome.step.queued
        if (!outcome.step.ok) ok = false
        for (const line of outcome.failureLines) cursor = this.bumpFailureRecord(cursor, line)
        if (outcome.commentCursor !== undefined) {
          cursor = { ...cursor, lastComments: { ...cursor.lastComments, [outcome.key]: outcome.commentCursor } }
        }
      }
    }

    cursor = {
      ...cursor,
      successes: cursor.successes + (consideredInRound > 0 ? 1 : 0),
      watched: set.size,
      listSummary,
      checkedAt: this.nowIso(),
    }
    await this.writePlatform(platform, cursor)
    if (ok) this.log(`health community:issue:${platform} state=up message=""`)
    return { ok, considered: consideredInRound, changed, queued }
  }

  /** Read and clear the pair queue of one key (P4 consumption). */
  async drainQueue(key: string): Promise<SnapshotPair<IssueSnapshot>[]> {
    const queue = readQueue(this.options.cursors, key)
    await this.writeQueue(key, { ...queue, pairs: [] })
    return [...queue.pairs]
  }

  /** Stop every watch (the row disposer calls this). */
  dispose(): void {
    this.watched.github?.clear()
    this.watched.gitcode?.clear()
    this.cache.clear()
  }

  private bumpFailure(platform: NonNullable<Platform>, line: string): PlatformCursorRecord {
    return this.bumpFailureRecord({ ...this.cursorOf(platform), rounds: this.cursorOf(platform).rounds + 1 }, line)
  }

  private bumpFailureRecord(cursor: PlatformCursorRecord, line: string): PlatformCursorRecord {
    const failures = cursor.failures.includes(line) ? cursor.failures : [...cursor.failures, line]
    return { ...cursor, failures }
  }

  private async writePlatform(platform: NonNullable<Platform>, cursor: PlatformCursorRecord): Promise<void> {
    this.cursors$.set(platform, cursor)
    await this.options.cursors.put(`issue:${platform}`, { token: JSON.stringify(cursor), updatedAt: this.nowIso() })
  }

  private async writeQueue(key: string, record: IssueQueueRecord): Promise<void> {
    await this.options.cursors.put(`${key}:issuequeue`, { token: JSON.stringify(record), updatedAt: this.nowIso() })
  }

  /** Stored shape from a poll; `firstSeenAt`/`events` survive a later change. */
  private buildSnapshot(ref: IssueRef, detail: IssueDetail, lastComment: LastComment | undefined, stored: IssueSnapshot | undefined): IssueSnapshot {
    return {
      platform: ref.platform,
      owner: ref.owner,
      repo: ref.repo,
      number: ref.number,
      title: detail.title,
      state: detail.state,
      labels: [...detail.labels].sort(),
      assignees: [...detail.assignees].sort(),
      comments: detail.comments,
      updatedAt: detail.updatedAt,
      lastCommentBy: lastComment?.by ?? null,
      lastCommentAt: lastComment?.at ?? null,
      firstSeenAt: stored?.firstSeenAt ?? this.nowIso(),
      lastSeenAt: this.nowIso(),
      events: stored?.events ?? [],
    }
  }

  /** Write the pair (queue) and the snapshot, in the PR watch's order. */
  private async apply(ref: IssueRef, before: IssueSnapshot | undefined, after: IssueSnapshot, detail: IssueDetail): Promise<{ queued: boolean } | null> {
    const key = issueKey(ref)
    const queue = readQueue(this.options.cursors, key)
    if (before === undefined) {
      if (queue.pending === null && queue.pairs.length >= QUEUE_CAPACITY) {
        // Same capacity cell as the PR queue: first observation waits for room.
        this.log(`health community:issue:${ref.platform}:${ref.owner}/${ref.repo}/${String(ref.number)} state=degraded message="queue-full"`)
        return null
      }
      const seq = queue.nextSeq
      const at = detail.updatedAt.length > 0 ? detail.updatedAt : this.nowIso()
      let working: IssueQueueRecord = { ...queue, nextSeq: seq + 1, pending: { seq, snapshot: after, at, retries: 0 } }
      working = this.makeRoom(working)
      await this.writeQueue(key, working)
      await this.options.issueTable.put(key, after)
      const pair: SnapshotPair<IssueSnapshot> = { key, before: null, after, at }
      working = this.appendPair(working, pair)
      await this.writeQueue(key, working)
      this.options.onPair?.(pair)
      return { queued: true }
    }
    if (!issueDiffers(before, after)) {
      // `lastSeenAt` alone moves: refresh it once it is a minute stale, so a
      // steady issue costs one small write per minute rather than one per poll.
      if ((this.options.now ?? (() => new Date()))().getTime() - Date.parse(before.lastSeenAt) >= 60_000) {
        await this.options.issueTable.put(key, { ...before, lastSeenAt: after.lastSeenAt })
      }
      return { queued: false }
    }
    const at = detail.updatedAt.length > 0 ? detail.updatedAt : this.nowIso()
    const pair: SnapshotPair<IssueSnapshot> = { key, before, after, at }
    // Same change already queued (crash between queue and snapshot writes): the
    // record was written by this code path once, so the same graded signature
    // cannot be a genuine second change.
    if (queue.lastApplied !== null && issueDiffSignature(queue.lastApplied.after) === issueDiffSignature(after)) {
      await this.options.issueTable.put(key, after)
      return { queued: false }
    }
    const seq = queue.nextSeq
    let working = this.makeRoom({ ...queue, nextSeq: seq + 1 })
    if (working.pairs.length >= QUEUE_CAPACITY) {
      const dropped: IssueQueueRecord = { ...working, dropped: queue.dropped + 1, nextSeq: seq }
      await this.writeQueue(key, dropped)
      this.log(`health community:issue:${ref.platform}:${ref.owner}/${ref.repo}/${String(ref.number)} state=degraded message="queue-full dropped"`)
      await this.options.issueTable.put(key, after)
      return { queued: false }
    }
    working = this.appendPair(working, pair)
    working = { ...working, applied: seq, lastApplied: { seq, before, after } }
    await this.writeQueue(key, working)
    await this.options.issueTable.put(key, after)
    this.options.onPair?.(pair)
    return { queued: true }
  }

  /** Capacity table, copied from the PR queue: evict only change pairs. */
  private makeRoom(queue: IssueQueueRecord): IssueQueueRecord {
    if (queue.pairs.length < QUEUE_CAPACITY) return queue
    const index = queue.pairs.findIndex((pair) => pair.before !== null)
    if (index === -1) return queue
    const pairs = queue.pairs.filter((_, cursor) => cursor !== index)
    return { ...queue, pairs, dropped: queue.dropped + 1 }
  }

  private appendPair(queue: IssueQueueRecord, pair: SnapshotPair<IssueSnapshot>): IssueQueueRecord {
    return { ...queue, pairs: [...queue.pairs, pair], applied: queue.nextSeq - 1, pending: null }
  }
}

/** Signature of the graded fields (duplicate-pair detection). */
function issueDiffSignature(snapshot: IssueSnapshot): string {
  return JSON.stringify([snapshot.state, [...snapshot.labels].sort(), [...snapshot.assignees].sort(), snapshot.comments, snapshot.lastCommentBy, snapshot.lastCommentAt, snapshot.title])
}

/** Turn a stored key back into a ref (the watch set stores plain strings). */
function keyOfKey(key: string): IssueRef {
  const [platform, owner, repo, number] = key.split('/')
  return { platform: platform as NonNullable<Platform>, owner, repo, number: Number(number) }
}

/** Build the poller with the row's defaults. */
export function makeIssueWatchService(options: IssueWatchOptions): IssueWatchService {
  return new IssueWatchService(options)
}

/** In-memory tables the smoke and tests drive (never used by the row itself). */
export function createIssueMemoryTables(): {
  issueTable: IssueTable
  cursors: CursorTable
  issues: Map<string, IssueSnapshot>
  cursorsMap: Map<string, { token: string; updatedAt: string }>
} {
  const issues = new Map<string, IssueSnapshot>()
  const cursorsMap = new Map<string, { token: string; updatedAt: string }>()
  return {
    issues,
    cursorsMap,
    issueTable: {
      get: (key) => issues.get(key),
      put: async (key, value) => {
        issues.set(key, value)
      },
    },
    cursors: {
      get: (key) => cursorsMap.get(key),
      put: async (key, value) => {
        cursorsMap.set(key, value)
      },
      delete: async (key) => cursorsMap.delete(key),
    },
  }
}
