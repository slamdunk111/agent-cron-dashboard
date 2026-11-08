/**
 * Change engine (P4, plan §3.1–§3.2).
 *
 * Consumes **snapshot pairs only** — never a poll result, never a raw host
 * answer — and produces graded {@link ChangeEvent}s. Pairs arrive two ways:
 *
 * 1. `consumePair(pair, scope)` — the P2/P3 `onPair` hook feeds a pair that was
 *    just written (in memory, no storage read).
 * 2. `consumeKey(key, scope)` / `sweep()` — a cursor scan calls the producer's
 *    own `drainQueue(key)` so pairs queued by an earlier process are graded too.
 *
 * Hard constraint (batch rule 2): the queue record is **never rewritten here**.
 * `drainQueue` already clears `pairs` and leaves `dropped`, `applied`,
 * `nextSeq`, `pending` and `lastApplied` untouched; this module only reads
 * those counters (to name a loss) and never reorders or re-queues anything.
 */
import type { ChangeEvent, ChangeEvidence, ChangeKind, SnapshotPair } from '../../../../contracts/events.ts'
import type { IssueSnapshot, PrSnapshot } from '../../../../contracts/records.ts'
import { EVIDENCE_CAP_TRUNCATION_MARKER, gradeChanges, isFirstObservation, type GradedChange } from './grade.ts'

/** Storage surface the engine reads and writes (the row's domain handles). */
export interface EventsTable {
  put(key: string, value: ChangeEvent): Promise<void>
  get(key: string): ChangeEvent | undefined
}

/** Snapshot tables the engine writes the event ring back into. */
export interface PrSnapshotTable {
  get(key: string): PrSnapshot | undefined
  put(key: string, value: PrSnapshot): Promise<void>
}

/** Issue snapshot table (same shape). */
export interface IssueSnapshotTable {
  get(key: string): IssueSnapshot | undefined
  put(key: string, value: IssueSnapshot): Promise<void>
}

/** Cursor table: read for the drop counters, never written by this module. */
export interface CursorTable {
  get(key: string): { readonly token: string; readonly updatedAt: string } | undefined
  put(key: string, value: { readonly token: string; readonly updatedAt: string }): Promise<void>
  delete(key: string): Promise<boolean>
}

/** What a consumer (the chamber) needs from the engine. */
export interface ChangeEngineOptions {
  readonly events: EventsTable
  readonly prTable: PrSnapshotTable
  readonly issueTable: IssueSnapshotTable
  readonly cursors: CursorTable
  /** Drain one producer queue (P2 `PrWatchService.drainQueue` / P3 `IssueWatchService.drainQueue`). */
  readonly drainQueue: (key: string) => Promise<readonly SnapshotPair<unknown>[]>
  /** Debounce window; same subject + same kind inside it merges. */
  readonly debounceMs?: number
  /** Login of the polling account (P3 `isForeignReply` needs it). */
  readonly me?: string
  readonly now?: () => Date
  readonly log?: (line: string) => void
  /** Called for every event that survived grading (the notifier routes it). */
  readonly onEvent?: (event: ChangeEvent, graded: GradedChange) => void | Promise<void>
}

/** Ring size of a snapshot's graded-event history (`contracts/records.ts`). */
export const RING_SIZE = 50

/** Evidence entries one merged event may carry (plan §3.2). */
export const EVIDENCE_CAP = 8

/** One merged window: the first event, how many further reports came in, and the graded signature seen last. */
interface MergeSlot {
  readonly first: string
  count: number
  lastAt: string
  /** `<before>|<after>` of the graded values: the same set twice is not a new report. */
  readonly lastSignature: string
}

/** A graded change waiting for grading by key (subject identity). */
export type PairScope = 'pr' | 'issue'

/**
 * Grades snapshot pairs, merges duplicates, and persists events.
 *
 * Nothing here throws: every failure is one `health` line and the engine keeps
 * the other keys moving (a broken key must not stop the batch).
 */
export class ChangeEngine {
  private readonly options: ChangeEngineOptions
  private readonly log: (line: string) => void
  /** Merge windows per `subject.key|kind`. */
  private readonly windows = new Map<string, MergeSlot>()
  /** Events produced since construction (gate reads it). */
  private produced = 0

  constructor(options: ChangeEngineOptions) {
    this.options = options
    this.log = options.log ?? ((line: string) => console.log(line))
  }

  /** Total events produced (machine source for the smoke). */
  get eventCount(): number {
    return this.produced
  }

  /** Events currently held in merge windows (merged originals of the window). */
  get windowSize(): number {
    return this.windows.size
  }

  /** The window length the engine uses. */
  get debounceMs(): number {
    return this.options.debounceMs ?? 300_000
  }

  private nowIso(): string {
    return (this.options.now ?? (() => new Date()))().toISOString()
  }

  /**
   * Grade one pair handed by a producer hook.
   * @param pair - the pair P2/P3 just wrote.
   * @param scope - `pr` or `issue` (which table names the subject).
   * @returns the events this pair produced.
   */
  async consumePair(pair: SnapshotPair<unknown>, scope: PairScope): Promise<ChangeEvent[]> {
    const graded = this.gradeOf(pair, scope)
    return this.emit(pair.key, graded, pair.at)
  }

  /**
   * Drain one queue through the producer and grade every pair it held.
   * @param key - subject key (`<platform>/<owner>/<repo>/<number>`).
   * @param scope - which queue suffix / snapshot table the key belongs to.
   * @returns the events these pairs produced.
   */
  async consumeKey(key: string, scope: PairScope): Promise<ChangeEvent[]> {
    let pairs: readonly SnapshotPair<unknown>[]
    try {
      pairs = await this.options.drainQueue(key)
    } catch (error) {
      this.log(`health core:queue:${key} state=degraded message="drain failed: ${error instanceof Error ? error.message : String(error)}"`)
      return []
    }
    const out: ChangeEvent[] = []
    for (const pair of pairs) {
      // The drained pair carries the queue's own `at`; grade it in queue order.
      out.push(...(await this.consumePair(pair, scope)))
    }
    return out
  }

  /**
   * Grade every queued pair left by an earlier process.
   * @param keys - session/queue router table (read-only here).
   * @returns how many keys were swept and how many pairs produced events.
   */
  async sweep(keys: readonly { readonly key: string; readonly scope: PairScope }[]): Promise<{ keys: number; events: number }> {
    let events = 0
    for (const entry of keys) events += (await this.consumeKey(entry.key, entry.scope)).length
    return { keys: keys.length, events }
  }

  /**
   * Name the pairs a subject's queue has lost (read-only).
   * @param key - subject key.
   * @returns `{ dropped, lastApplied }` copied verbatim from the cursor record.
   */
  lossOf(key: string, scope: PairScope): { dropped: number; lastApplied: unknown } {
    const suffix = scope === 'pr' ? ':queue' : ':issuequeue'
    const row = this.options.cursors.get(`${key}${suffix}`)
    if (row === undefined) return { dropped: 0, lastApplied: null }
    try {
      const parsed = JSON.parse(row.token) as { dropped?: number; lastApplied?: unknown }
      return { dropped: parsed.dropped ?? 0, lastApplied: parsed.lastApplied ?? null }
    } catch {
      return { dropped: 0, lastApplied: null }
    }
  }

  /** Grade one pair with the scope's rule table. */
  private gradeOf(pair: SnapshotPair<unknown>, scope: PairScope): GradedChange[] {
    const foreign = scope === 'issue' ? this.foreignReply(pair) : null
    return gradeChanges(scope, pair.before, pair.after, foreign)
  }

  /**
   * Whether the issue pair's new last comment came from somebody else (P3 rule).
   * @param pair - issue pair.
   * @returns `true`/`false`, or `null` when the pair carries no new comment.
   */
  private foreignReply(pair: SnapshotPair<unknown>): boolean | null {
    const before = pair.before as IssueSnapshot | null
    const after = pair.after as IssueSnapshot
    if (before === null) return null
    if (after.comments <= before.comments) return null
    const login = this.options.me
    if (login === undefined || after.lastCommentBy === null || after.lastCommentBy === '') return null
    return after.lastCommentBy !== login
  }

  /** Turn graded changes into stored events (merge, persist, ring, callback). */
  private async emit(key: string, graded: readonly GradedChange[], at: string): Promise<ChangeEvent[]> {
    const out: ChangeEvent[] = []
    for (const change of graded) {
      const now = this.nowIso()
      const mergeKey = `${key}|${change.kind}`
      let event: ChangeEvent
      if (isFirstObservation(change.kind)) {
        // ADR P2-1: a first-observation event is never merged with anything.
        event = this.eventOf(key, change, at, now, 1)
      } else {
        const slot = this.windows.get(mergeKey)
        const signature = `${JSON.stringify(change.evidence)}|${change.summary}`
        if (slot !== undefined && slot.lastSignature === signature) {
          // The identical graded set reported twice is the same change, not a
          // second one: it never bumps the merge count (and never moves the clock).
          continue
        }
        if (slot !== undefined && Date.parse(now) - Date.parse(slot.lastAt) < this.debounceMs) {
          slot.count += 1
          slot.lastAt = now
          event = this.eventOf(key, change, slot.first, now, slot.count)
        } else {
          this.windows.set(mergeKey, { first: now, count: 1, lastAt: now, lastSignature: signature })
          event = this.eventOf(key, change, now, now, 1)
        }
      }
      await this.persist(event, change)
      this.produced += 1
      out.push(event)
      await this.options.onEvent?.(event, change)
    }
    return out
  }

  /** Build one event (evidence capped, summary carries the merge count). */
  private eventOf(key: string, change: GradedChange, firstAt: string, at: string, count: number): ChangeEvent {
    const evidence: ChangeEvidence[] = change.evidence.slice(0, EVIDENCE_CAP)
    if (change.evidence.length > EVIDENCE_CAP) {
      evidence.push({ field: EVIDENCE_CAP_TRUNCATION_MARKER, before: EVIDENCE_CAP, after: change.evidence.length })
    }
    const summary = count > 1 ? `${change.summary} ×${count}` : change.summary
    return {
      level: change.level,
      kind: change.kind as ChangeKind,
      subject: { scope: 'community', key, label: key.split('/').slice(-1)[0] ?? key },
      summary,
      evidence,
      at: count > 1 ? firstAt : at,
    }
  }

  /** Store the event in the log domain and append it to the subject's ring. */
  private async persist(event: ChangeEvent, change: GradedChange): Promise<void> {
    // Unique key: two events can share the same instant, subject and kind.
    await this.options.events.put(`${event.at}|${event.subject.key}|${event.kind}|${String(this.produced)}`, event)
    const key = event.subject.key
    const snapshot = event.kind.startsWith('pr-') ? this.options.prTable.get(key) : this.options.issueTable.get(key)
    if (snapshot === undefined) return
    const ring = [...snapshot.events, event]
    const trimmed = ring.length > RING_SIZE ? ring.slice(ring.length - RING_SIZE) : ring
    void change
    if (event.kind.startsWith('pr-')) await this.options.prTable.put(key, { ...(snapshot as PrSnapshot), events: trimmed })
    else await this.options.issueTable.put(key, { ...(snapshot as IssueSnapshot), events: trimmed })
  }
}
