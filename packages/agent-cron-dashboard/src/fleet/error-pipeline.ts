/**
 * ErrorPipeline (P6 task 2, design §5.4): the whole ledger chain.
 *
 *   ErrorEntry ─▶ mask ─▶ fingerprint ─▶ ledger row (dedupe, count, sample ring)
 *                                         ├─ new ▶ record `open` + `error-record-opened`
 *                                         └─ seen while resolved/wontfix ▶ `reopened` + `error-record-reopened`
 *   pending rows ─▶ analyser ─▶ `analyzed`
 *   `fix-applied` rows ─▶ read `workbench_fleet_jobs.<sourceId>/<jobId>.greenStreak`
 *                        ── >= N ──▶ `verified-resolved` + `error-record-verified`
 *
 * Nothing here awaits the model: `ingest` stores the row and schedules the analysis
 * (a microtask in a live session, a serial pump in a host process without an agent
 * — the `dsh-jobs` registry needs an owning agent session that a bare host row
 * does not have, see plan §4 D5). Nothing here writes remotely: the hermes `script_error`
 * bridge reads `cron_run_events` through the P5 whitelist (`mode=ro`).
 */
import { CHANGE_LEVELS, type ChangeEvent, type ChangeKind } from '../../../../contracts/events.ts'
import type { ErrorEntry, SinceCursor } from '../../../../contracts/fleet-source.ts'
import type { FingerprintRecord, FleetJobRecord, IssueRecord, IssueAnalysis } from '../../../../contracts/records.ts'
import { recordWithAnalysis, maybeVerify, type AnalysisPayload } from './issues-machine.ts'
import { ErrorAnalyzer, type AnalysisJobContext } from './analyzer.ts'
import { signatureOf } from './fingerprint.ts'
import { sampleOf } from './secret-mask.ts'
import { parseJsonRows } from './hermes-ssh.ts'
import { decodeEventKey, eventKeyOf } from './event-key.ts'

/** Samples kept per record (design §5.4 “samples 环形”, contract says max 5). */
export const SAMPLE_RING = 5

/** Inference failure marker stored on `analysis.state` when the model was not usable. */
const PENDING_ANALYSIS: IssueAnalysis = Object.freeze({
  state: 'pending',
  rootCauseHypothesis: null,
  impact: null,
  suggestedFix: [],
  confidence: null,
  needMoreInfo: [],
  analyzedAt: null,
  model: null,
})

/** Storage surfaces the pipeline reads and writes (the row hands it the opened tables). */
export interface PipelineTables {
  readonly errors: { get(key: string): IssueRecord | undefined; put(key: string, value: IssueRecord): Promise<void>; keys(): readonly string[]; delete(key: string): Promise<boolean> }
  readonly fingerprints: { get(key: string): FingerprintRecord | undefined; put(key: string, value: FingerprintRecord): Promise<void>; keys(): readonly string[]; delete(key: string): Promise<boolean> }
  readonly jobs: { get(key: string): FleetJobRecord | undefined; keys(): readonly string[] }
  readonly events: { get(key: string): ChangeEvent | undefined; put(key: string, value: ChangeEvent): Promise<void>; keys(): readonly string[] }
}

/** Options of the pipeline. */
export interface ErrorPipelineOptions {
  readonly tables: PipelineTables
  /** Absent when `analysis.llm.enabled` is false or no LLM service is mounted (both are named in the log). */
  readonly analyzer?: ErrorAnalyzer
  /** `analysis.greenRunsToVerify`. */
  readonly greenRunsToVerify: number
  /** `analysis.retentionDays`. */
  readonly retentionDays: number
  /** Newest-first recent runs of one job (the analyser prompt reads them). */
  readonly recentRuns?: (sourceId: string, jobId: string) => readonly { readonly startedAt: string; readonly status: string }[]
  readonly now?: () => Date
  readonly log?: (line: string) => void
  /** Initial event index so keys stay unique after a restart. */
  readonly startIndex?: number
}

/** One ingest pass outcome (the smoke and the tools name the counts). */
export interface IngestOutcome {
  readonly entries: number
  readonly opened: number
  readonly revisited: number
  readonly reopened: number
  /** Rows that changed at all (opened ∪ revisited ∪ reopened). */
  readonly touched: readonly string[]
}

/** Outcome of one pump pass. */
export interface PumpOutcome {
  /** Records analysed successfully in this pass. */
  readonly analyzed: number
  /** Records whose analysis stayed pending (model absent or failed). */
  readonly pending: number
  /** Records that reached `verified-resolved` in this pass. */
  readonly verified: readonly string[]
}

/** The ledger pipeline. */
export class ErrorPipeline {
  private readonly tables: PipelineTables
  private readonly analyzer: ErrorAnalyzer | undefined
  /** `analysis.greenRunsToVerify` (the resolver names it in its text). */
  readonly greenRunsToVerify: number
  private readonly retentionDays: number
  private readonly recentRunsOf: (sourceId: string, jobId: string) => readonly { readonly startedAt: string; readonly status: string }[]
  private readonly now: () => Date
  private readonly log: (line: string) => void
  private index: number
  /** Signatures queued for analysis (insertion order, no duplicates). */
  private readonly queue = new Set<string>()
  private pumping: Promise<PumpOutcome> | null = null
  /** Records dropped by retention (evidence for the smoke). */
  readonly dropped: string[] = []

  constructor(options: ErrorPipelineOptions) {
    this.tables = options.tables
    this.analyzer = options.analyzer
    this.greenRunsToVerify = options.greenRunsToVerify
    this.retentionDays = options.retentionDays
    this.recentRunsOf = options.recentRuns ?? (() => [])
    this.now = options.now ?? (() => new Date())
    this.log = options.log ?? (() => undefined)
    this.index = options.startIndex ?? this.maxEventIndex()
    for (const key of this.tables.errors.keys()) {
      const record = this.tables.errors.get(key)
      if (record !== undefined && record.state === 'open') this.queue.add(record.signature)
    }
  }

  /** Event index to continue from (the largest `<n>` already stored in our own key shape). */
  private maxEventIndex(): number {
    let max = 0
    for (const key of this.tables.events.keys()) {
      const parts = decodeEventKey(key)
      if (parts === null || !parts.subjectKey.startsWith('error/')) continue
      if (parts.index > max) max = parts.index
    }
    return max
  }

  /** Signatures waiting for analysis (the smoke prints the size). */
  pending(): number {
    return this.queue.size
  }

  /** Records in the ledger, newest first by `lastSeen`. */
  records(): IssueRecord[] {
    const out: IssueRecord[] = []
    for (const key of this.tables.errors.keys()) {
      const record = this.tables.errors.get(key)
      if (record !== undefined) out.push(record)
    }
    return out.sort((left, right) => right.lastSeen.localeCompare(left.lastSeen))
  }

  /** One record by id. */
  record(recordId: string): IssueRecord | undefined {
    return this.tables.errors.get(recordId)
  }

  /**
   * Store and deduplicate one batch of error observations (synchronous part only).
   * @param entries - entries as handed in by a `FleetSource`.
   * @param options - `autoAnalyze` schedules the analysis queue right away (default true).
   */
  async ingest(entries: readonly ErrorEntry[], options: { readonly autoAnalyze?: boolean } = {}): Promise<IngestOutcome> {
    const touched: string[] = []
    let opened = 0
    let revisited = 0
    let reopened = 0
    for (const entry of entries) {
      const outcome = await this.ingestOne(entry)
      if (outcome === null) continue
      touched.push(outcome.recordId)
      if (outcome.kind === 'opened') opened += 1
      if (outcome.kind === 'revisited') revisited += 1
      if (outcome.kind === 'reopened') reopened += 1
    }
    if (options.autoAnalyze !== false) this.schedule()
    return { entries: entries.length, opened, revisited, reopened, touched }
  }

  /**
   * Schedule the analysis pump without blocking the caller.
   * @param fail - optional sink for a rejected pump; the default writes to the log
   *   (an observer that inspects the rejection is what P7t2 tests).
   */
  schedule(fail?: (error: unknown) => void): void {
    const onError =
      fail ??
      ((error: unknown) => {
        this.log(`p6: analysis pump failed (${error instanceof Error ? error.message : String(error)})`)
      })
    queueMicrotask(() => {
      void this.pump().catch(onError)
    })
  }

  /** Drain the analysis queue (serial: one record at a time). */
  async pump(): Promise<PumpOutcome> {
    const running = this.pumping
    if (running !== null) return running
    const work = this.pumpOnce()
    this.pumping = work
    try {
      return await work
    } finally {
      this.pumping = null
    }
  }

  private async pumpOnce(): Promise<PumpOutcome> {
    let analyzed = 0
    let pending = 0
    const signatures = [...this.queue]
    this.queue.clear()
    for (const signature of signatures) {
      const record = this.findBySignature(signature)
      if (record === undefined || record.state !== 'open') continue
      if (this.analyzer === undefined) {
        pending += 1
        await this.tables.errors.put(record.recordId, { ...record, analysis: { ...record.analysis, state: 'pending' } })
        this.log(`p6 analysis record=${record.recordId} state=pending reason=no-model-configured`)
        continue
      }
      const context = this.contextOf(record)
      const result = await this.analyzer.run(record, context)
      if (result.state === 'done' && result.output !== null) {
        const payload: AnalysisPayload = { ...result.output, model: result.model }
        const next = recordWithAnalysis(record, payload, this.now().toISOString())
        await this.tables.errors.put(next.recordId, next)
        analyzed += 1
        this.log(`p6 analysis record=${next.recordId} state=analyzed model=${result.model} attempts=${String(result.attempts)}`)
      } else {
        pending += 1
        await this.tables.errors.put(record.recordId, { ...record, analysis: { ...record.analysis, state: 'failed' } })
        this.log(`p6 analysis record=${record.recordId} state=pending failure=${String(result.failure)}`)
      }
    }
    return { analyzed, pending, verified: [] }
  }

  /** Re-run the records whose analysis stayed pending (a retry path used by the tools and the smoke). */
  async reanalyze(): Promise<PumpOutcome> {
    for (const record of this.records()) if (record.state === 'open') this.queue.add(record.signature)
    return this.pump()
  }

  /**
   * Read the green streak of every `fix-applied` record and verify what reached N.
   * @param at - ISO 8601 instant of the pass (defaults to now).
   */
  async verify(at = this.now().toISOString()): Promise<readonly string[]> {
    const verified: string[] = []
    for (const record of this.records()) {
      if (record.state !== 'fix-applied' || record.jobId === null) continue
      const job = this.tables.jobs.get(`${record.sourceId}/${record.jobId}`)
      if (job === undefined) continue
      const next = maybeVerify(record, job.greenStreak, this.greenRunsToVerify, at)
      if (next === record) continue
      await this.tables.errors.put(next.recordId, next)
      await this.emit('error-record-verified', next, [
        { field: 'state', before: record.state, after: next.state },
        { field: `workbench_fleet_jobs.${record.sourceId}/${record.jobId}.greenStreak`, before: null, after: job.greenStreak },
      ])
      verified.push(next.recordId)
      this.log(`p6 verified record=${next.recordId} streak=${String(job.greenStreak)} threshold=${String(this.greenRunsToVerify)} at=${at}`)
    }
    return verified
  }

  /** Roll verified rows past the retention window (only resolved rows are ever dropped). */
  async retain(): Promise<readonly string[]> {
    const horizon = this.now().getTime() - this.retentionDays * 86_400_000
    const dropped: string[] = []
    for (const record of this.records()) {
      if (record.state !== 'verified-resolved' || record.verifiedAt === null) continue
      if (Date.parse(record.verifiedAt) > horizon) continue
      await this.tables.errors.delete(record.recordId)
      await this.tables.fingerprints.delete(record.signature)
      dropped.push(record.recordId)
      this.dropped.push(record.recordId)
    }
    if (dropped.length > 0) this.log(`p6 retention dropped=${String(dropped.length)}`)
    return dropped
  }

  /** Store one record back (the resolver writes through this). */
  async save(record: IssueRecord): Promise<void> {
    await this.tables.errors.put(record.recordId, record)
  }

  /** Emit the `error-record-*` event into the P4 domain (key `<at>|<subjectKey>|<kind>|<n>`). */
  async emit(kind: ChangeKind, record: IssueRecord, evidence: readonly { field: string; before: unknown; after: unknown }[]): Promise<string> {
    const at = this.now().toISOString()
    this.index += 1
    const event: ChangeEvent = {
      level: CHANGE_LEVELS[kind],
      kind,
      subject: { scope: 'fleet', key: `error/${record.recordId}`, label: record.signature.slice(0, 12), sourceId: record.sourceId },
      summary: `${kind} ${record.signature.slice(0, 12)} count=${String(record.count)}`,
      evidence: [{ field: 'state', before: record.state, after: record.state }, ...evidence],
      at,
    }
    await this.tables.events.put(eventKeyOf(event.at, event.subject.key, event.kind, this.index), event)
    this.log(`p6_event kind=${kind} key=${event.subject.key} level=${event.level} at=${at}`)
    return event.subject.key
  }

  /** Find the record of one signature through the fingerprint index. */
  private findBySignature(signature: string): IssueRecord | undefined {
    const fingerprint = this.tables.fingerprints.get(signature)
    return fingerprint === undefined ? undefined : this.tables.errors.get(fingerprint.recordId)
  }

  /** The analyser's job context (job record + recent runs). */
  private contextOf(record: IssueRecord): AnalysisJobContext {
    const job = record.jobId === null ? undefined : this.tables.jobs.get(`${record.sourceId}/${record.jobId}`)
    const runs = record.jobId === null ? [] : this.recentRunsOf(record.sourceId, record.jobId)
    return { job, recentRuns: runs }
  }

  /** Store one observation; returns null for a skipped (empty) entry. */
  private async ingestOne(entry: ErrorEntry): Promise<{ recordId: string; kind: 'opened' | 'revisited' | 'reopened' } | null> {
    if (entry.message.trim() === '') return null
    const signature = signatureOf(entry)
    const sample = sampleOf({ occurredAt: entry.occurredAt, severity: entry.severity, message: entry.message })
    const existing = this.findBySignature(signature)
    if (existing === undefined) {
      const recordId = `${entry.sourceId}-${signature.slice(0, 12)}`
      const record: IssueRecord = {
        recordId,
        signature,
        sourceId: entry.sourceId,
        jobId: entry.jobId ?? null,
        state: 'open',
        severity: entry.severity,
        count: 1,
        firstSeen: entry.occurredAt,
        lastSeen: entry.occurredAt,
        samples: [sample],
        analysis: { ...PENDING_ANALYSIS },
        resolution: [],
        verifiedAt: null,
      }
      await this.tables.errors.put(recordId, record)
      await this.tables.fingerprints.put(signature, { signature, recordId, count: 1, lastSeen: entry.occurredAt })
      await this.emit('error-record-opened', record, [
        { field: 'sourceId', before: null, after: entry.sourceId },
        { field: 'jobId', before: null, after: entry.jobId ?? null },
        { field: 'sample', before: null, after: sample.message },
      ])
      this.queue.add(signature)
      this.log(`p6 opened record=${recordId} signature=${signature.slice(0, 12)} count=1 at=${entry.occurredAt}`)
      return { recordId, kind: 'opened' }
    }
    const reopened = existing.state === 'verified-resolved' || existing.state === 'closed-wontfix'
    const samples = [...existing.samples, sample].slice(-SAMPLE_RING)
    const next: IssueRecord = {
      ...existing,
      state: reopened ? 'reopened' : existing.state,
      count: existing.count + 1,
      lastSeen: entry.occurredAt,
      samples,
      analysis: reopened ? { ...PENDING_ANALYSIS } : existing.analysis,
      verifiedAt: reopened ? null : existing.verifiedAt,
      resolution: reopened
        ? [...existing.resolution, { kind: 'reopened', at: this.now().toISOString(), by: 'scheduler', note: `recurrence after ${existing.state}` }]
        : existing.resolution,
    }
    await this.tables.errors.put(next.recordId, next)
    await this.tables.fingerprints.put(signature, { signature, recordId: existing.recordId, count: next.count, lastSeen: entry.occurredAt })
    if (reopened) {
      await this.emit('error-record-reopened', next, [
        { field: 'state', before: existing.state, after: 'reopened' },
        { field: 'count', before: existing.count, after: next.count },
        { field: 'sample', before: null, after: sample.message },
      ])
      this.queue.add(signature)
      this.log(`p6 reopened record=${next.recordId} signature=${signature.slice(0, 12)} count=${String(next.count)} at=${entry.occurredAt}`)
      return { recordId: next.recordId, kind: 'reopened' }
    }
    if (next.state === 'open' && next.analysis.state === 'failed') this.queue.add(signature)
    return { recordId: next.recordId, kind: 'revisited' }
  }
}

/** One `cron_run_events` row as the bridge reads it (P5 probes §4 schema). */
interface RunEventRow {
  readonly id: number
  readonly job_id: string
  readonly event_type: string
  readonly status: string | null
  readonly detail: string | null
  readonly occurred_at: string
}

/**
 * Bridge the P5 run ledger into the error face: every `script_error` row is
 * one `ErrorEntry`. `cron_run_events` is the only place the hermes script
 * failures live (P5 `fetchErrorEntries` reads `errors.log`), and the plan
 * (§2.5) keeps the bridge on the P6 side so the P5 adapters stay untouched.
 * @param options - remote reader (already whitelisted), database path, and the persisted cursor.
 */
export interface RunEventBridgeOptions {
  readonly sourceId: string
  readonly dbPath: string
  /** Runs the whitelisted `sqlite3 -json 'file:…?mode=ro'` read. */
  readonly query: (sql: string, signal?: AbortSignal) => Promise<{ code: number; stdout: string; stderr?: string }>
  readonly log?: (line: string) => void
}

/** The SQL the bridge sends (same shape as P5 probes §8, `mode=ro` only). */
export const RUN_EVENTS_SQL = 'SELECT id,job_id,event_type,status,detail,occurred_at FROM cron_run_events WHERE id > :lastId ORDER BY id'

/** Cursor token the bridge persists under `<sourceId>:run-events`. */
export interface RunEventCursor {
  readonly token: string
}

/**
 * Pull new `script_error` rows as error entries.
 * @param bridge - reader and identity.
 * @param cursor - previous token (`{"runs":<maxId>}`), null for the first read.
 */
export async function pullRunEventErrors(bridge: RunEventBridgeOptions, cursor: RunEventCursor | null): Promise<{ entries: ErrorEntry[]; cursor: RunEventCursor; rows: number }> {
  let lastId = 0
  if (cursor !== null) {
    try {
      const parsed = JSON.parse(cursor.token) as { runs?: unknown }
      if (typeof parsed.runs === 'number' && Number.isFinite(parsed.runs)) lastId = parsed.runs
    } catch {
      lastId = 0
    }
  }
  const sql = RUN_EVENTS_SQL.replace(':lastId', String(lastId))
  const result = await bridge.query(sql)
  if (result.code !== 0) throw new Error(`cron_run_events read failed rc=${String(result.code)} ${String(result.stderr ?? '').slice(0, 120)}`)
  const rows = parseJsonRows<RunEventRow>(result.stdout)
  let maxId = lastId
  const entries: ErrorEntry[] = []
  for (const row of rows) {
    if (row.id > maxId) maxId = row.id
    if (row.event_type !== 'script_error') continue
    entries.push({
      sourceId: bridge.sourceId,
      jobId: row.job_id,
      occurredAt: row.occurred_at,
      severity: 'error',
      message: row.detail ?? `script_error (id ${String(row.id)})`,
      raw: `${bridge.dbPath}#${String(row.id)}`,
    })
  }
  bridge.log?.(`p6 bridge source=${bridge.sourceId} rows=${String(rows.length)} script_error=${String(entries.length)} cursor=${String(maxId)}`)
  return { entries, cursor: { token: JSON.stringify({ runs: maxId }) }, rows: rows.length }
}

/** Re-export so callers need only this module for the `SinceCursor` shape of the bridge. */
export type RunEventCursorLike = SinceCursor
