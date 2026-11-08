/**
 * Hermes SSH adapter (P5, probes/hermes.md).
 *
 * The NAS hermes gateway keeps job definitions in `cron/jobs.json` (not in a
 * SQLite table), its run ledger in `cron_run_events` (the `status` column is
 * always NULL, so outcomes come from the event-type pairing) and its metrics in
 * `cron_run_metrics` (three counters, no auto-increment id, so a full snapshot).
 * Every read goes through {@link RunRemote}, which enforces the read-only
 * whitelist before an ssh process exists.
 */
import type { ErrorEntry, ErrorSeverity, FleetJob, FleetRun, FleetRunStatus, SinceCursor } from '../../../../contracts/fleet-source.ts'
import type { SourceHealth } from '../../../../contracts/records.ts'
import type { FleetSource } from '../../../../contracts/fleet-source.ts'
import type { FleetSourceConfig } from '../../../../contracts/fleet-source.ts'
import { redact } from '../community/identity.ts'
import type { RunRemote, SshTarget } from './ssh-exec.ts'
import { advance, parseLogLines, type FileMark } from './log-tail.ts'

/** Default state paths measured on the NAS (probes/hermes.md §8). */
export const HERMES_DEFAULTS = {
  dbPath: '/root/.hermes/state.db',
  jobsJson: '/root/.hermes/cron/jobs.json',
  errorsLog: '/root/.hermes/logs/errors.log',
} as const

/** Bytes read from the tail of `errors.log` per tick. */
export const HERMES_LOG_WINDOW_BYTES = 262144

/** One parsed `cron_run_events` row (the JSON shape sqlite3 emits). */
export interface HermesRunRow {
  readonly id: number
  readonly job_id: string
  readonly event_type: string
  readonly status: string | null
  readonly detail: string | null
  readonly occurred_at: string
}

/** One `cron/jobs.json` entry (only the fields the adapter reads). */
interface HermesJobJson {
  readonly id?: unknown
  readonly name?: unknown
  readonly schedule?: { readonly display?: unknown; readonly expr?: unknown }
  readonly script?: unknown
  readonly last_run_at?: unknown
  readonly last_status?: unknown
}

/** Options of the adapter (all injectable so tests replay fixtures). */
export interface HermesOptions {
  readonly config: FleetSourceConfig
  readonly run: RunRemote
  /** Secret strings masked out of every message before it leaves the adapter. */
  readonly secrets?: readonly (string | undefined)[]
  readonly now?: () => Date
  readonly log?: (line: string) => void
  /** Directories consulted before `file:` URIs (empty in production). */
  readonly allowDirs?: readonly string[]
}

/** Values stored between calls for one stream. */
interface HermesCursors {
  readonly runs?: number
  readonly log?: FileMark
}

/**
 * Group raw events into runs: one `run` row plus, when the same job has a
 * `script_error` at the same instant, a failed outcome (probes/hermes.md §4).
 * @param rows - rows pulled by the incremental query.
 * @returns run records; orphan `script_error` rows without a matching `run` are
 * still reported as failed runs (the event existed, the run row may be older).
 */
export function runsFromRows(rows: readonly HermesRunRow[]): FleetRun[] {
  const groups = new Map<string, { jobId: string; at: string; error?: string; sawRun: boolean }>()
  for (const row of rows) {
    const key = `${row.job_id}|${row.occurred_at}`
    const slot = groups.get(key) ?? { jobId: row.job_id, at: row.occurred_at, sawRun: false }
    if (row.event_type === 'run') slot.sawRun = true
    if (row.event_type === 'script_error') slot.error = row.detail ?? row.event_type
    groups.set(key, slot)
  }
  const runs: FleetRun[] = []
  for (const slot of groups.values()) {
    // measured shape: `run` opens a job's activity and `script_error` marks the failure
    const status: FleetRunStatus = slot.error === undefined ? 'ok' : 'failed'
    const run: FleetRun = { jobId: slot.jobId, startedAt: slot.at, status }
    if (slot.error !== undefined) runs.push({ ...run, finishedAt: slot.at, exitDetail: slot.error })
    else runs.push(run)
  }
  return runs
}

/** Map a hermes `last_status` word to the adapter status vocabulary. */
function statusOf(word: unknown): FleetRunStatus | null {
  if (word === 'ok') return 'ok'
  if (word === 'error' || word === 'failed') return 'failed'
  if (word === 'timeout') return 'timeout'
  return null
}

/** One entry of `jobs.json`. */
export function jobOf(raw: unknown, jobId: string): FleetJob {
  const entry = (raw ?? {}) as HermesJobJson
  const schedule = entry.schedule ?? {}
  const expr = typeof schedule.display === 'string' ? schedule.display : typeof schedule.expr === 'string' ? schedule.expr : null
  return {
    id: typeof entry.id === 'string' ? entry.id : jobId,
    name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : jobId,
    schedule: expr,
    script: typeof entry.script === 'string' ? entry.script : null,
    lastRunAt: typeof entry.last_run_at === 'string' ? entry.last_run_at : null,
    lastStatus: statusOf(entry.last_status),
  }
}

/** Parse the `cron/jobs.json` payload. */
export function parseJobsJson(text: string): readonly HermesJobJson[] {
  const parsed = JSON.parse(text) as { jobs?: unknown } | unknown[]
  const jobs = Array.isArray(parsed) ? parsed : Array.isArray((parsed as { jobs?: unknown }).jobs) ? ((parsed as { jobs: unknown[] }).jobs) : []
  return jobs as readonly HermesJobJson[]
}

/** severity word → contract severity. */
function severityOf(word: string): ErrorSeverity {
  return word === 'CRITICAL' ? 'critical' : 'error'
}

/** The single SQL the adapter issues for the run stream (design §5.2). */
export function runsSql(lastId: number): string {
  return `SELECT id,job_id,event_type,status,detail,occurred_at FROM cron_run_events WHERE id > ${String(lastId)} ORDER BY id`
}

/** Parse the `stat -c '%d %i %s'` output into a mark. */
export function markOf(statOut: string, fallbackSize: number): { size: number; inode: string } {
  const parts = statOut.trim().split(/\s+/)
  if (parts.length < 3) return { size: fallbackSize, inode: 'unknown' }
  return { inode: `${parts[0]}.${parts[1]}`, size: Number(parts[2]) }
}

/**
 * The hermes SSH adapter.
 */
export class HermesSshAdapter implements FleetSource {
  readonly id: string
  readonly kind = 'hermes-ssh' as const
  private readonly options: HermesOptions
  private readonly target: SshTarget
  private readonly dbPath: string
  private readonly jobsJson: string
  private readonly errorsLog: string

  constructor(options: HermesOptions) {
    this.options = options
    this.id = options.config.id
    const ssh = options.config.ssh
    if (ssh === undefined) throw new Error(`hermes-ssh source ${options.config.id} has no ssh block`)
    this.target = { host: ssh.host, sshOptions: ssh.sshOptions, connectTimeoutSec: 10 }
    this.dbPath = ssh.dbPath ?? HERMES_DEFAULTS.dbPath
    this.jobsJson = HERMES_DEFAULTS.jobsJson
    this.errorsLog = ssh.errorsLog ?? HERMES_DEFAULTS.errorsLog
  }

  private log(line: string): void {
    this.options.log?.(line)
  }

  /** Read the whole `cron/jobs.json` through stat + tail. */
  async listJobs(signal?: AbortSignal): Promise<FleetJob[]> {
    const stat = await this.options.run({ kind: 'stat', format: '%s', path: this.jobsJson }, signal)
    if (stat.code !== 0) throw new Error(`jobs.json stat failed rc=${String(stat.code)}`)
    const size = Number(stat.stdout.trim())
    const tail = await this.options.run({ kind: 'tail-bytes', path: this.jobsJson, bytes: size }, signal)
    if (tail.code !== 0) throw new Error(`jobs.json read failed rc=${String(tail.code)}`)
    const entries = parseJobsJson(tail.stdout)
    return entries.map((entry, index) => jobOf(entry, typeof entry.id === 'string' ? entry.id : `job-${String(index)}`))
  }

  /** Incremental run ledger (`id > lastId`). */
  async fetchRuns(cursor: SinceCursor | null, signal?: AbortSignal): Promise<{ runs: FleetRun[]; cursor: SinceCursor }> {
    const decode = (): HermesCursors => {
      if (cursor === null) return {}
      try {
        return JSON.parse(cursor.token) as HermesCursors
      } catch {
        return {}
      }
    }
    const state = decode()
    const lastId = state.runs ?? 0
    const result = await this.options.run({ kind: 'sqlite-json', dbPath: this.dbPath, sql: runsSql(lastId) }, signal)
    if (result.code !== 0) throw new Error(`cron_run_events read failed rc=${String(result.code)}`)
    const rows = parseJsonRows<HermesRunRow>(result.stdout)
    const runs = runsFromRows(rows)
    const maxId = rows.reduce((max, row) => Math.max(max, Number(row.id)), lastId)
    const next: HermesCursors = { ...state, runs: maxId }
    return { runs, cursor: { token: JSON.stringify(next) } }
  }

  /** Incremental error stream from `errors.log` (offset + rotation aware). */
  async fetchErrorEntries(cursor: SinceCursor | null, signal?: AbortSignal): Promise<{ entries: ErrorEntry[]; cursor: SinceCursor }> {
    const state = cursor === null ? {} : safeParse<HermesCursors>(cursor.token)
    const mark = state.log ?? null
    const read = await this.readLog(mark, signal)
    const entries: ErrorEntry[] = []
    if (read.text !== '') {
      const lines = parseLogLines('hermes-errors', read.text.split('\n'))
      for (const line of lines) {
        if (line.level !== 'error' && line.level !== 'warning' && line.level !== 'critical') continue
        const message = redact(line.message, this.options.secrets ?? this.defaultSecrets())
        entries.push({ sourceId: this.id, occurredAt: line.occurredAt, severity: severityOf(line.level.toUpperCase()), message, raw: `${this.errorsLog}@${String(read.offset)}` })
      }
    }
    const next: HermesCursors = { ...state, log: read.next }
    return { entries, cursor: { token: JSON.stringify(next) } }
  }

  /** Connectivity probe: `stat` on the database with a wall-clock round trip. */
  async health(signal?: AbortSignal): Promise<SourceHealth> {
    const startedAt = (this.options.now ?? (() => new Date()))().getTime()
    const result = await this.options.run({ kind: 'stat', format: '%Y', path: this.dbPath }, signal)
    const elapsed = (this.options.now ?? (() => new Date()))().getTime() - startedAt
    const checkedAt = new Date().toISOString()
    if (result.code !== 0) {
      return { sourceId: this.id, state: 'down', latencyMs: elapsed, checkedAt, consecutiveFailures: 1, message: `stat failed rc=${String(result.code)}` }
    }
    return { sourceId: this.id, state: 'up', latencyMs: elapsed, checkedAt, consecutiveFailures: 0, message: null }
  }

  /** Secrets masked out of log lines when the caller did not pass any. */
  private defaultSecrets(): readonly (string | undefined)[] {
    return this.options.allowDirs ?? []
  }

  /** Read the tail window and advance the offset (stat + wc -c + tail -c). */
  private async readLog(mark: FileMark | null, signal?: AbortSignal): Promise<{ text: string; next: FileMark; offset: number; rotated: boolean; dropped: boolean }> {
    const stat = await this.options.run({ kind: 'stat', format: '%d %i %s', path: this.errorsLog }, signal)
    const wc = await this.options.run({ kind: 'wc-c', path: this.errorsLog }, signal)
    if (stat.code !== 0 || wc.code !== 0) throw new Error(`errors.log stat failed rc=${String(stat.code)}/${String(wc.code)}`)
    const current = markOf(stat.stdout, Number(wc.stdout.trim().split(/\s+/)[0] ?? 0))
    const tail = await this.options.run({ kind: 'tail-bytes', path: this.errorsLog, bytes: HERMES_LOG_WINDOW_BYTES }, signal)
    if (tail.code !== 0) throw new Error(`errors.log read failed rc=${String(tail.code)}`)
    const result = advance(mark, current, tail.stdout, HERMES_LOG_WINDOW_BYTES)
    if (result.rotated) this.log(`hermes ${this.id}: errors.log rotated (offset reset)`)
    if (result.dropped) this.log(`hermes ${this.id}: errors.log window overflow (dropped bytes counted)`)
    return result
  }
}

/** Parse a `sqlite3 -json` payload into typed rows. */
export function parseJsonRows<T>(stdout: string): T[] {
  const text = stdout.trim()
  if (text === '') return []
  const parsed: unknown = JSON.parse(text)
  if (Array.isArray(parsed)) return parsed as T[]
  return [parsed as T]
}

/** Parse a cursor token defensively. */
function safeParse<T>(token: string): T {
  try {
    return JSON.parse(token) as T
  } catch {
    return {} as T
  }
}
