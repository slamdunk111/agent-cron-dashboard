/**
 * PR watch service (P2, plan §3.3–§3.4).
 *
 * Reads change requests through a `WatchSource` (GitCode through `ctx.forge`,
 * GitHub through the adapter this batch ships), writes `PrSnapshot` rows into
 * `workbench_snapshot_pr`, and stores snapshot pairs for P4 in a **single
 * atomic cursor record** per key (`<platform>/<owner>/<repo>/<number>:queue`).
 *
 * The capacity table is the plan's one rule: the queue holds 200 pairs; a
 * first-observation pair is never evicted (it retries), a change pair is
 * dropped oldest-first and counted. `applied`/`nextSeq`/`pending`/
 * `lastApplied`/`retries` live in the same record so a crash can only land
 * before or after one atomic write.
 *
 * Constraints from the plan (P1 batch): checks come only from the snapshot's
 * checks/rollup (`fetchChecks` is unsupported), `unresolvedThreads` is always
 * 0, `reviewDecision` is count-derived, and no write operation is ever called.
 */
import { GITCODE_CAPABILITIES, GITCODE_UNSUPPORTED } from '../../../../contracts/gitcode-capabilities.ts'
import type { SnapshotPair } from '../../../../contracts/events.ts'
import type { PrSnapshot } from '../../../../contracts/records.ts'
import type { Platform } from './identity.ts'
import { redact } from './identity.ts'

/** Storage key of one change request. */
export interface WatchRef {
  /** Non-null: an undefined platform would make every `round#` line unusable. */
  readonly platform: NonNullable<Platform>
  readonly owner: string
  readonly repo: string
  readonly number: number
}

/** Result of one poll, shaped like the forge `ChangeRequestUpdate` P2 consumes. */
export interface WatchUpdate {
  readonly key: string
  readonly fetchedAt: number
  readonly snapshot?: ForgeSnapshot
  readonly failure?: { readonly code: string; readonly message: string }
}

/** The part of `ChangeRequestSnapshot` the watch reads. */
export interface ForgeSnapshot {
  readonly title?: string
  readonly state: 'open' | 'closed' | 'merged'
  readonly draft: boolean
  readonly author?: string | null
  readonly headBranch?: string
  readonly headSha: string
  readonly baseBranch?: string
  readonly additions?: number
  readonly deletions?: number
  readonly mergeability: 'mergeable' | 'conflicting' | 'unknown'
  readonly mergeReady?: boolean
  readonly reviewDecision: 'approved' | 'changes-requested' | 'review-required' | 'none'
  readonly checks?: readonly { readonly name: string }[]
  readonly checksRollup: 'none' | 'pending' | 'success' | 'failure'
  readonly updatedAt: string
  readonly closedAt?: string | null
}

/** The polling surface a platform has to provide. */
export interface WatchSource {
  subscribe(ref: WatchRef, listener: (update: WatchUpdate) => void): () => void
}

/** Minimal table surface of `workbench_snapshot_pr`. */
export interface PrTable {
  get(key: string): PrSnapshot | undefined
  put(key: string, value: PrSnapshot): Promise<void>
}

/** Minimal table surface of `workbench_cursors`. */
export interface CursorTable {
  get(key: string): { readonly token: string; readonly updatedAt: string } | undefined
  put(key: string, value: { readonly token: string; readonly updatedAt: string }): Promise<void>
  delete(key: string): Promise<boolean>
}

/** Queue record stored at `<key>:queue`. */
export interface QueueRecord {
  readonly pairs: ReadonlyArray<SnapshotPair<PrSnapshot>>
  readonly dropped: number
  readonly applied: number
  readonly nextSeq: number
  readonly pending: { readonly seq: number; readonly snapshot: PrSnapshot; readonly at: string; readonly retries: number } | null
  readonly lastApplied: { readonly seq: number; readonly before: PrSnapshot; readonly after: PrSnapshot } | null
}

/** How many pairs one queue holds (plan §3.4). */
export const QUEUE_CAPACITY = 200

/** Diffed fields (plan §3.3-2 "seven fields"). */
const DIFF_FIELDS = ['state', 'draft', 'mergeability', 'checksRollup', 'reviewDecision', 'headSha', 'title'] as const

/** Key used by both tables. */
export function watchKey(ref: WatchRef): string {
  return `${ref.platform}/${ref.owner}/${ref.repo}/${ref.number}`
}

/** Empty queue record for a key. */
export function emptyQueue(): QueueRecord {
  return { pairs: [], dropped: 0, applied: 0, nextSeq: 1, pending: null, lastApplied: null }
}

function readQueue(cursors: CursorTable, key: string): QueueRecord {
  const row = cursors.get(`${key}:queue`)
  if (row === undefined) return emptyQueue()
  try {
    const parsed = JSON.parse(row.token) as Partial<QueueRecord>
    return { ...emptyQueue(), ...parsed, pairs: parsed.pairs ?? [] } as QueueRecord
  } catch {
    return emptyQueue()
  }
}

/** Options of {@link PrWatchService}. */
export interface PrWatchOptions {
  readonly prTable: PrTable
  readonly cursors: CursorTable
  readonly sources: Partial<Record<Platform, WatchSource>>
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly now?: () => Date
  readonly log?: (line: string) => void
  /** P4 hook; absent means the queue is only persisted. */
  readonly onPair?: (pair: SnapshotPair<PrSnapshot>) => void
}

/** One watched change request. */
interface Entry {
  readonly ref: WatchRef
  readonly dispose: () => void
}

/**
 * Watches the seeding result and keeps every constraint the plan pins down.
 */
export class PrWatchService {
  private readonly options: PrWatchOptions
  private readonly entries = new Map<string, Entry>()
  private readonly log: (line: string) => void
  /** Per-platform round counters (plan §5.1: one round per source cycle). */
  private readonly rounds = new Map<NonNullable<Platform>, number>()
  private readonly lastRoundAt = new Map<NonNullable<Platform>, number>()

  constructor(options: PrWatchOptions) {
    this.options = options
    const tokens = Object.values(options.env ?? {}).filter((value): value is string => typeof value === 'string' && value.length > 0)
    this.log = options.log ?? ((line: string) => console.log(redact(line, tokens)))
  }

  /** Number of active watches. */
  get size(): number {
    return this.entries.size
  }

  /** Rounds observed per platform (machine source for the gate). */
  get roundCounts(): ReadonlyMap<NonNullable<Platform>, number> {
    return new Map(this.rounds)
  }

  /**
   * Apply one seeding result: add new keys, keep existing ones, drop the rest.
   * @returns number of watches added and removed.
   */
  applyWatchSet(refs: readonly WatchRef[]): { added: number; removed: number } {
    const wanted = new Map(refs.map((ref) => [watchKey(ref), ref]))
    let removed = 0
    for (const [key, entry] of this.entries) {
      if (wanted.has(key)) continue
      entry.dispose()
      this.entries.delete(key)
      removed += 1
    }
    let added = 0
    for (const [key, ref] of wanted) {
      if (this.entries.has(key)) continue
      const source = this.options.sources[ref.platform]
      if (source === undefined) {
        // No source for the platform: name it instead of silently watching nothing.
        this.log(`health community:${ref.platform} state=down message="no watch source for ${ref.platform}"`)
        continue
      }
      const dispose = source.subscribe(ref, (update) => {
        void this.handle(ref, update)
      })
      this.entries.set(key, { ref, dispose })
      added += 1
    }
    return { added, removed }
  }

  /** Stop every watch (the row disposer calls this). */
  dispose(): void {
    for (const entry of this.entries.values()) entry.dispose()
    this.entries.clear()
  }

  /** Read and clear the queue of one key (P4 consumption). */
  async drainQueue(key: string): Promise<SnapshotPair<PrSnapshot>[]> {
    const queue = readQueue(this.options.cursors, key)
    await this.writeQueue(key, { ...queue, pairs: [] })
    return [...queue.pairs]
  }

  private async writeQueue(key: string, record: QueueRecord): Promise<void> {
    await this.options.cursors.put(`${key}:queue`, { token: JSON.stringify(record), updatedAt: this.nowIso() })
  }

  private nowIso(): string {
    return (this.options.now ?? (() => new Date()))().toISOString()
  }

  /** One poll result, turned into storage writes (never throws). */
  private async handle(ref: WatchRef, update: WatchUpdate): Promise<void> {
    const key = watchKey(ref)
    try {
      this.countRound(ref, update.fetchedAt)
      if (update.failure !== undefined) {
        const state = update.failure.code === 'not-found' || update.failure.code === 'unauthenticated' ? 'down' : 'degraded'
        this.log(`health community:${ref.platform}:pr:${ref.owner}/${ref.repo}/${ref.number} state=${state} message="${update.failure.code}: ${update.failure.message}"`)
        return
      }
      const snapshot = update.snapshot
      if (snapshot === undefined) return
      const current = this.options.prTable.get(key)
      const queue = readQueue(this.options.cursors, key)
      if (current === undefined) {
        await this.firstObservation(ref, snapshot, update.fetchedAt, queue)
        return
      }
      await this.change(ref, current, snapshot, update.fetchedAt, queue)
    } catch (error) {
      // A listener must not throw (forge contract): log one line and keep going.
      this.log(`health community:${ref.platform}:pr:${ref.owner}/${ref.repo}/${ref.number} state=degraded message="watch error: ${error instanceof Error ? error.message : String(error)}"`)
    }
  }

  /** Count one platform-level round per distinct `fetchedAt`. */
  private countRound(ref: WatchRef, fetchedAt: number): void {
    const platform = ref.platform
    if (platform === undefined) return
    const previous = this.lastRoundAt.get(platform)
    if (previous === fetchedAt) return
    this.lastRoundAt.set(platform, fetchedAt)
    const next = (this.rounds.get(platform) ?? 0) + 1
    this.rounds.set(platform, next)
    this.log(`round#${next} platform=${platform} key=${ref.owner}/${ref.repo}#${ref.number}`)
  }

  /** First observation: pending marker first, snapshot second, pair third. */
  private async firstObservation(ref: WatchRef, snapshot: ForgeSnapshot, fetchedAt: number, queue: QueueRecord): Promise<void> {
    const key = watchKey(ref)
    if (queue.pending === null && queue.pairs.length >= QUEUE_CAPACITY) {
      // Capacity table, first-observation × "all first" cell: write nothing, retry
      // on the next poll (the snapshot table is still empty, so the predicate holds).
      this.log(`health community:${ref.platform}:pr:${ref.owner}/${ref.repo}/${ref.number} state=degraded message="queue-full"`)
      return
    }
    const seeded: PrSnapshot = {
      platform: ref.platform,
      owner: ref.owner,
      repo: ref.repo,
      number: ref.number,
      title: snapshot.title ?? '',
      state: snapshot.state,
      draft: snapshot.draft,
      mergeability: snapshot.mergeability,
      reviewDecision: snapshot.reviewDecision,
      checksRollup: snapshot.checksRollup,
      headSha: snapshot.headSha,
      updatedAt: snapshot.updatedAt,
      firstSeenAt: this.nowIso(),
      lastSeenAt: this.nowIso(),
      events: [],
    }
    const seq = queue.nextSeq
    const at = new Date(fetchedAt).toISOString()
    let working: QueueRecord = { ...queue, nextSeq: seq + 1, pending: { seq, snapshot: seeded, at, retries: 0 } }
    // The pending marker lands before the snapshot: a crash in between is
    // recoverable (snapshot missing -> this arm runs again, same seq).
    working = this.makeRoom(working)
    await this.writeQueue(key, working)
    await this.options.prTable.put(key, seeded)
    const pair: SnapshotPair<PrSnapshot> = { key, before: null, after: seeded, at }
    working = this.appendPair(working, pair)
    await this.writeQueue(key, working)
    this.options.onPair?.(pair)
  }

  /** Later polls: diff, enqueue when something changed, always refresh `lastSeenAt`. */
  private async change(ref: WatchRef, before: PrSnapshot, snapshot: ForgeSnapshot, fetchedAt: number, queue: QueueRecord): Promise<void> {
    const key = watchKey(ref)
    const after = this.nextSnapshot(before, snapshot)
    const differing = DIFF_FIELDS.filter((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]))
    if (differing.length === 0) {
      await this.options.prTable.put(key, { ...after, lastSeenAt: this.nowIso() })
      return
    }
    const duplicate =
      queue.lastApplied !== null &&
      queue.lastApplied.before.headSha === before.headSha &&
      queue.lastApplied.after.headSha === snapshot.headSha &&
      queue.lastApplied.after.checksRollup === snapshot.checksRollup
    const at = new Date(fetchedAt).toISOString()
    const pair: SnapshotPair<PrSnapshot> = { key, before, after, at }
    if (duplicate) {
      // Same change already queued (a crash between queue and snapshot writes):
      // only advance the snapshot, never enqueue twice.
      await this.options.prTable.put(key, { ...after, lastSeenAt: this.nowIso() })
      return
    }
    const seq = queue.nextSeq
    let working = this.makeRoom({ ...queue, pending: queue.pending, nextSeq: seq + 1 })
    const full = working.pairs.length >= QUEUE_CAPACITY && working.dropped === queue.dropped
    if (full) {
      // Capacity table, change pair × "all first" cell: write only the snapshot.
      this.log(`health community:${ref.platform}:pr:${ref.owner}/${ref.repo}/${ref.number} state=degraded message="queue-full"`)
      await this.options.prTable.put(key, { ...after, lastSeenAt: this.nowIso() })
      return
    }
    working = this.appendPair(working, pair)
    working = { ...working, applied: seq, lastApplied: { seq, before, after } }
    await this.writeQueue(key, working)
    await this.options.prTable.put(key, { ...after, lastSeenAt: this.nowIso() })
    this.options.onPair?.(pair)
  }

  /** Snapshot the change carries, keeping the contract's fixed fields. */
  private nextSnapshot(before: PrSnapshot, snapshot: ForgeSnapshot): PrSnapshot {
    return {
      ...before,
      title: snapshot.title ?? before.title,
      state: snapshot.state,
      draft: snapshot.draft,
      mergeability: snapshot.mergeability,
      reviewDecision: snapshot.reviewDecision,
      checksRollup: snapshot.checksRollup,
      headSha: snapshot.headSha,
      updatedAt: snapshot.updatedAt,
      lastSeenAt: this.nowIso(),
    }
  }

  /** Capacity table: make room for one pair, evicting only change pairs. */
  private makeRoom(queue: QueueRecord): QueueRecord {
    if (queue.pairs.length < QUEUE_CAPACITY) return queue
    let index = -1
    for (let cursor = 0; cursor < queue.pairs.length; cursor += 1) {
      if (queue.pairs[cursor].before !== null) {
        index = cursor
        break
      }
    }
    if (index === -1) return queue
    const pairs = queue.pairs.filter((_, cursor) => cursor !== index)
    return { ...queue, pairs, dropped: queue.dropped + 1 }
  }

  /** Append a pair (caller decided the room). */
  private appendPair(queue: QueueRecord, pair: SnapshotPair<PrSnapshot>): QueueRecord {
    return { ...queue, pairs: [...queue.pairs, pair], applied: queue.nextSeq - 1, pending: null }
  }
}

/** Capability notes the UI reads instead of chasing the provider (plan §3.5). */
export function capabilityNotes(): readonly string[] {
  const unsupported = [...GITCODE_UNSUPPORTED]
  return [
    `GitCode: unresolved discussion count unknown (reported as 0, never "no unresolved threads")${unsupported.length > 0 ? `; unsupported: ${unsupported.join(', ')}` : ''}`,
    'GitHub (this batch reader): unresolved discussion count unknown; write operations not available',
  ]
}

/** Whether a write capability may be used; always false for GitCode in this batch. */
export function writeCapabilities(): 'unsupported' {
  return 'unsupported'
}

/** Number of capabilities the constant carries (read by the inspect surface). */
export function capabilityCount(): number {
  return GITCODE_CAPABILITIES.length
}
