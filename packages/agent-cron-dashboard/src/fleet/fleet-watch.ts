/**
 * FleetWatchService (P5, plan §3.6): pull every source in parallel, keep failures
 * independent, and persist jobs / cursors / health / graded events.
 *
 * Failure isolation is the point of this module: a source that throws or times
 * out is marked `down`, backs off on its own schedule, and never stops the other
 * sources from being read. Graded changes go to the P4 `workbench_events`
 * domain under the key shape P4 uses (`<at>|<subjectKey>|<kind>|<n>`).
 */
import { CHANGE_LEVELS, type ChangeEvent } from '../../../../contracts/events.ts'
import type { ErrorEntry, FleetJob, FleetRun, SinceCursor } from '../../../../contracts/fleet-source.ts'
import type { FleetSource } from '../../../../contracts/fleet-source.ts'
import type { CursorRecord, FleetJobRecord, SourceHealth } from '../../../../contracts/records.ts'
import { gradeHealth, gradeRun, type FleetGraded } from './grade-fleet.ts'

/** Storage surfaces the watch writes (the row hands it the opened domain tables). */
export interface FleetWatchTables {
  readonly jobs: { get(key: string): FleetJobRecord | undefined; put(key: string, value: FleetJobRecord): Promise<void>; keys(): readonly string[] }
  readonly cursors: { get(key: string): CursorRecord | undefined; put(key: string, value: CursorRecord): Promise<void> }
  readonly health: { get(key: string): SourceHealth | undefined; put(key: string, value: SourceHealth): Promise<void>; keys(): readonly string[] }
  readonly events: { get(key: string): ChangeEvent | undefined; put(key: string, value: ChangeEvent): Promise<void> }
}

/** Round outcome of one source (the smoke and the status tool read it). */
export interface SourceRound {
  readonly sourceId: string
  readonly state: SourceHealth['state']
  readonly jobs: number
  readonly runs: number
  readonly errors: number
  /** Milliseconds the source must wait before its next attempt. */
  readonly backoffMs: number
  readonly skipped: boolean
  readonly message: string | null
}

/** Options of the watch. */
export interface FleetWatchOptions {
  readonly sources: readonly FleetSource[]
  readonly tables: FleetWatchTables
  readonly intervalMs?: number
  readonly backoffMaxMs?: number
  readonly now?: () => Date
  readonly log?: (line: string) => void
  /** Set to false to keep processes and timers out of the tests. */
  readonly autoStart?: boolean
  /** Initial event index so keys stay unique after a restart. */
  readonly startIndex?: number
}

/** Default poll interval (design §7 `poll.fleetIntervalMs`). */
const DEFAULT_INTERVAL_MS = 300_000
/** Default backoff ceiling (design §7 `poll.backoffMaxMs`). */
const DEFAULT_BACKOFF_MAX_MS = 3_600_000

/** Next backoff for a source with `failures` consecutive failures. */
export function backoffFor(failures: number, intervalMs: number, backoffMaxMs: number): number {
  if (failures <= 0) return 0
  return Math.min(intervalMs * 2 ** (failures - 1), backoffMaxMs)
}

/** OK, RUNNING, FAILED words → the run status the grader compares. */
function compareOf(run: FleetRun): 'ok' | 'failed' | 'running' | 'timeout' {
  return run.status
}

/**
 * The watch: one method per behaviour (round, timer, stop) plus the persisted tables.
 */
export class FleetWatchService {
  private readonly options: FleetWatchOptions
  private readonly tables: FleetWatchTables
  private readonly intervalMs: number
  private readonly backoffMaxMs: number
  private timer: ReturnType<typeof setInterval> | undefined
  private index: number
  private readonly failures = new Map<string, number>()
  private readonly nextAt = new Map<string, number>()
  private readonly lastStatus = new Map<string, 'ok' | 'failed' | 'running' | 'timeout'>()
  private readonly lastHealth = new Map<string, SourceHealth['state']>()
  private readonly streaks = new Map<string, number>()
  private tail: Promise<unknown> = Promise.resolve()

  constructor(options: FleetWatchOptions) {
    this.options = options
    this.tables = options.tables
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
    this.backoffMaxMs = options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS
    this.index = options.startIndex ?? 0
    for (const source of options.sources) this.hydrate(source)
    if (options.autoStart !== false) this.start()
  }

  private now(): Date {
    return (this.options.now ?? (() => new Date()))()
  }

  private log(line: string): void {
    this.options.log?.(line)
  }

  /** Reload the persisted status/streak/health so a restart keeps grading right. */
  private hydrate(source: FleetSource): void {
    for (const key of this.tables.jobs.keys()) {
      if (!key.startsWith(`${source.id}/`)) continue
      const record = this.tables.jobs.get(key)
      if (record === undefined) continue
      if (record.lastStatus !== null) this.lastStatus.set(`${source.id}|${record.jobId}`, record.lastStatus)
      this.streaks.set(`${source.id}|${record.jobId}`, record.greenStreak)
    }
    const storedHealth = this.tables.health.get(source.id)
    if (storedHealth !== undefined) this.lastHealth.set(source.id, storedHealth.state)
  }

  /** Start the periodic timer. */
  start(): void {
    if (this.timer !== undefined) return
    this.timer = setInterval(() => {
      void this.runOnce()
    }, this.intervalMs)
  }

  /** Stop the timer (called by the row disposer). */
  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }

  /** Serialise rounds: overlapping ticks join the one in flight instead of racing. */
  async runOnce(): Promise<SourceRound[]> {
    const round = this.tail.then(() => this.round())
    this.tail = round.catch(() => undefined)
    return round
  }

  private async round(): Promise<SourceRound[]> {
    const outcomes = await Promise.allSettled(this.options.sources.map(async (source) => this.pollSource(source)))
    return outcomes.map((outcome, index) => {
      if (outcome.status === 'fulfilled') return outcome.value
      const source = this.options.sources[index]!
      const reason = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)
      this.failures.set(source.id, (this.failures.get(source.id) ?? 0) + 1)
      const backoff = backoffFor(this.failures.get(source.id) ?? 1, this.intervalMs, this.backoffMaxMs)
      this.nextAt.set(source.id, this.now().getTime() + backoff)
      this.log(`fleet ${source.id}: round failed (${reason.slice(0, 120)}); backoff ${String(backoff)}ms`)
      return { sourceId: source.id, state: 'down', jobs: 0, runs: 0, errors: 0, backoffMs: backoff, skipped: false, message: reason }
    })
  }

  /** One source, one attempt; throws are caught by the round. */
  private async pollSource(source: FleetSource): Promise<SourceRound> {
    const nowMs = this.now().getTime()
    const due = this.nextAt.get(source.id) ?? 0
    if (nowMs < due) {
      const stored = this.tables.health.get(source.id)
      return { sourceId: source.id, state: stored?.state ?? 'down', jobs: 0, runs: 0, errors: 0, backoffMs: due - nowMs, skipped: true, message: 'backoff' }
    }
    const jobs = await source.listJobs()
    const runCursor = this.cursorOf(source.id, 'runs')
    const runPull = await source.fetchRuns(runCursor)
    const errorPull = await source.fetchErrorEntries(this.cursorOf(source.id, 'errors'))
    const health = await source.health()
    await this.persistJobs(source.id, jobs)
    await this.persistRuns(source.id, runPull.runs, jobs)
    await this.persistCursor(source.id, 'runs', runPull.cursor)
    await this.persistCursor(source.id, 'errors', errorPull.cursor)
    const healthBefore = this.lastHealth.get(source.id) ?? this.tables.health.get(source.id)?.state ?? null
    const gradedHealth = gradeHealth(healthBefore === null ? null : { ...health, state: healthBefore }, health)
    await this.persistHealth(health)
    for (const change of gradedHealth) await this.emit(source.id, source.id, change, source.id)
    this.lastHealth.set(source.id, health.state)
    this.failures.set(source.id, 0)
    this.nextAt.delete(source.id)
    this.log(`fleet ${source.id}: health=${health.state} jobs=${String(jobs.length)} runs=${String(runPull.runs.length)} errors=${String(errorPull.entries.length)}`)
    return { sourceId: source.id, state: health.state, jobs: jobs.length, runs: runPull.runs.length, errors: errorPull.entries.length, backoffMs: 0, skipped: false, message: health.message }
  }

  /** Read the persisted cursor token. */
  private cursorOf(sourceId: string, stream: 'runs' | 'errors'): SinceCursor | null {
    const record = this.tables.cursors.get(`${sourceId}:${stream}`)
    return record === undefined ? null : { token: record.token }
  }

  private async persistCursor(sourceId: string, stream: 'runs' | 'errors', cursor: SinceCursor): Promise<void> {
    await this.tables.cursors.put(`${sourceId}:${stream}`, { token: cursor.token, updatedAt: this.now().toISOString() })
  }

  /** Store one health row (domain key = source id). */
  private async persistHealth(health: SourceHealth): Promise<void> {
    await this.tables.health.put(health.sourceId, health)
  }

  /** Store job records with the running green streak. */
  private async persistJobs(sourceId: string, jobs: readonly FleetJob[]): Promise<void> {
    const collectedAt = this.now().toISOString()
    for (const job of jobs) {
      const key = `${sourceId}/${job.id}`
      const previous = this.tables.jobs.get(key)
      const streak = this.streaks.get(`${sourceId}|${job.id}`) ?? previous?.greenStreak ?? 0
      const record: FleetJobRecord = {
        sourceId,
        jobId: job.id,
        name: job.name,
        schedule: job.schedule,
        script: job.script,
        lastRunAt: job.lastRunAt ?? previous?.lastRunAt ?? null,
        lastStatus: job.lastStatus ?? previous?.lastStatus ?? null,
        greenStreak: streak,
        collectedAt,
      }
      await this.tables.jobs.put(key, record)
    }
  }

  /** Grade the pulled runs against the stored status and update streaks. */
  private async persistRuns(sourceId: string, runs: readonly FleetRun[], jobs: readonly FleetJob[]): Promise<void> {
    const names = new Map(jobs.map((job) => [job.id, job.name]))
    for (const run of runs) {
      const subject = `${sourceId}|${run.jobId}`
      const before = this.lastStatus.get(subject) ?? this.tables.jobs.get(`${sourceId}/${run.jobId}`)?.lastStatus ?? null
      const after = compareOf(run)
      this.lastStatus.set(subject, after)
      const streak = after === 'ok' ? (this.streaks.get(subject) ?? 0) + 1 : 0
      this.streaks.set(subject, streak)
      const jobKey = `${sourceId}/${run.jobId}`
      const record = this.tables.jobs.get(jobKey)
      if (record !== undefined) {
        await this.tables.jobs.put(jobKey, {
          ...record,
          name: names.get(run.jobId) ?? record.name,
          lastRunAt: run.startedAt,
          lastStatus: after,
          greenStreak: streak,
        })
      }
      for (const change of gradeRun(before, after, run.jobId)) await this.emit(sourceId, jobKey, change, names.get(run.jobId) ?? run.jobId)
    }
  }

  /** Write one graded change into the P4 event domain. */
  private async emit(sourceId: string, subjectKey: string, change: FleetGraded, label = sourceId): Promise<void> {
    const at = this.now().toISOString()
    this.index += 1
    const event: ChangeEvent = {
      level: CHANGE_LEVELS[change.kind],
      kind: change.kind,
      subject: { scope: 'fleet', key: subjectKey, label, sourceId },
      summary: change.summary,
      evidence: change.evidence,
      at,
    }
    await this.tables.events.put(`${at}|${subjectKey}|${change.kind}|${String(this.index)}`, event)
    this.log(`fleet_event kind=${change.kind} key=${subjectKey} level=${event.level} at=${at}`)
  }
}

/** Build the event key exactly the way P4 does (exported for the gate assertions). */
export function eventKeyOf(event: ChangeEvent, index: number): string {
  return `${event.at}|${event.subject.key}|${event.kind}|${String(index)}`
}

/** A stored error pulled by the watch (kept for the smoke's counters). */
export type PulledError = ErrorEntry
