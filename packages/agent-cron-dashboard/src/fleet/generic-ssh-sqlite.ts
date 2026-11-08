/**
 * Generic ssh-sqlite adapter (P5, plan §3.5).
 *
 * A community-shaped source: the user configures a host, a database path and a
 * handful of single-SELECT queries (`query` plus the optional `runsQuery` /
 * `jobsQuery` / `errorsQuery` from ADR P5-1). Every query goes through the same
 * {@link RunRemote} whitelist, and the read-only URI is applied by the executor,
 * so a SELECT that calls a side-effecting SQLite function still cannot write.
 */
import type { ErrorEntry, ErrorSeverity, FleetJob, FleetRun, FleetRunStatus, SinceCursor } from '../../../../contracts/fleet-source.ts'
import type { SourceHealth } from '../../../../contracts/records.ts'
import type { FleetSource, FleetSourceConfig } from '../../../../contracts/fleet-source.ts'
import { redact } from '../community/identity.ts'
import { markOf } from './hermes-ssh.ts'
import type { RunRemote, SshTarget } from './ssh-exec.ts'

/** One returned row (column names come straight from the query). */
type SqlRow = Record<string, unknown>

/** What the mapping skipped in the last call (named, never thrown). */
export interface GenericNotes {
  readonly runs: readonly string[]
  readonly jobs: readonly string[]
  readonly errors: readonly string[]
}

/** Options of the generic adapter. */
export interface GenericSourceConfig extends FleetSourceConfig {
  /** P5 (ADR P5-1): optional query keys of the generic adapter. */
  readonly query?: string
  readonly runsQuery?: string
  readonly jobsQuery?: string
  readonly errorsQuery?: string
}

export interface GenericOptions {
  readonly config: GenericSourceConfig
  readonly run: RunRemote
  readonly secrets?: readonly (string | undefined)[]
  readonly now?: () => Date
  readonly log?: (line: string) => void
}

/** The table columns a row must expose (missing ones are reported in {@link GenericNotes}). */
export const RUN_COLUMNS = ['id', 'job_id', 'started_at', 'status'] as const
/** Job columns the mapping reads. */
export const JOB_COLUMNS = ['job_id', 'name', 'schedule', 'script', 'last_run_at', 'last_status'] as const
/** Error columns the mapping reads. */
export const ERROR_COLUMNS = ['occurred_at', 'severity', 'message'] as const

/** Status word → contract status. */
function statusOf(word: unknown): FleetRunStatus {
  if (typeof word !== 'string') return 'running'
  const lower = word.toLowerCase()
  if (lower === 'ok' || lower === 'success' || lower === 'completed') return 'ok'
  if (lower === 'failed' || lower === 'failure' || lower === 'error') return 'failed'
  if (lower === 'timeout' || lower === 'timed_out') return 'timeout'
  return 'running'
}

/** Severity word → contract severity. */
function severityOf(word: unknown): ErrorSeverity {
  const lower = typeof word === 'string' ? word.toLowerCase() : 'error'
  if (lower === 'critical') return 'critical'
  if (lower === 'warning' || lower === 'warn') return 'warning'
  if (lower === 'info' || lower === 'debug') return 'info'
  return 'error'
}

/** The `id > :lastId` boundary is applied by the caller (the config query is a literal). */
export function boundarySql(sql: string, lastId: number): string {
  return sql.split(':lastId').join(String(lastId))
}

/** Map one runs row, naming any column it lacks. */
export function runOfRow(row: SqlRow, notes: string[]): FleetRun | undefined {
  const missing = RUN_COLUMNS.filter((column) => row[column] === undefined)
  for (const column of missing) notes.push(`missing column ${column}`)
  if (missing.length > 0) return undefined
  const started = String(row.started_at)
  return { jobId: String(row.job_id), startedAt: started, status: statusOf(row.status) }
}

/** Map one jobs row. */
export function jobOfRow(row: SqlRow, notes: string[]): FleetJob | undefined {
  if (row.job_id === undefined) {
    notes.push('missing column job_id')
    return undefined
  }
  const id = String(row.job_id)
  return {
    id,
    name: typeof row.name === 'string' && row.name !== '' ? row.name : id,
    schedule: typeof row.schedule === 'string' ? row.schedule : null,
    script: typeof row.script === 'string' ? row.script : null,
    lastRunAt: typeof row.last_run_at === 'string' ? row.last_run_at : null,
    lastStatus: typeof row.last_status === 'string' ? statusOf(row.last_status) : null,
  }
}

/** Map one errors row. */
export function errorOfRow(row: SqlRow, sourceId: string, secrets: readonly (string | undefined)[], notes: string[]): ErrorEntry | undefined {
  const missing = ERROR_COLUMNS.filter((column) => row[column] === undefined)
  for (const column of missing) notes.push(`missing column ${column}`)
  if (missing.length > 0) return undefined
  return {
    sourceId,
    occurredAt: String(row.occurred_at),
    severity: severityOf(row.severity),
    message: redact(String(row.message), secrets),
    raw: 'query',
  }
}

/** Parse a `sqlite3 -json` payload. */
export function parseRows(text: string): SqlRow[] {
  const trimmed = text.trim()
  if (trimmed === '') return []
  const parsed: unknown = JSON.parse(trimmed)
  return Array.isArray(parsed) ? (parsed as SqlRow[]) : [parsed as SqlRow]
}

/**
 * The generic ssh-sqlite adapter.
 */
export class GenericSshSqliteAdapter implements FleetSource {
  readonly id: string
  readonly kind = 'ssh-sqlite' as const
  /** Everything the last call skipped because a column was missing. */
  readonly notes: GenericNotes = { runs: [], jobs: [], errors: [] }
  private readonly options: GenericOptions
  private readonly target: SshTarget
  private readonly dbPath: string

  constructor(options: GenericOptions) {
    this.options = options
    this.id = options.config.id
    const ssh = options.config.ssh
    if (ssh === undefined) throw new Error(`ssh-sqlite source ${options.config.id} has no ssh block`)
    if (options.config.query === undefined) throw new Error(`ssh-sqlite source ${options.config.id} has no query`)
    this.target = { host: ssh.host, sshOptions: ssh.sshOptions, connectTimeoutSec: 10 }
    this.dbPath = ssh.dbPath ?? ''
  }

  private log(line: string): void {
    this.options.log?.(line)
  }

  /** Run one configured query. */
  private async query(sql: string, signal?: AbortSignal): Promise<SqlRow[]> {
    const result = await this.options.run({ kind: 'sqlite-json', dbPath: this.dbPath, sql }, signal)
    if (result.code !== 0) throw new Error(`query failed rc=${String(result.code)}`)
    return parseRows(result.stdout)
  }

  /** Job list from `jobsQuery` (falls back to the base `query`). */
  async listJobs(signal?: AbortSignal): Promise<FleetJob[]> {
    const sql = this.options.config.jobsQuery ?? this.options.config.query
    if (sql === undefined) return []
    const rows = await this.query(sql, signal)
    const mapped: FleetJob[] = []
    for (const row of rows) {
      const job = jobOfRow(row, this.notes.jobs as string[])
      if (job !== undefined) mapped.push(job)
    }
    if (this.notes.jobs.length > 0) this.log(`ssh-sqlite ${this.id}: ${this.notes.jobs.length} job column(s) missing`)
    return mapped
  }

  /** Incremental runs from `runsQuery` (falls back to the base `query`). */
  async fetchRuns(cursor: SinceCursor | null, signal?: AbortSignal): Promise<{ runs: FleetRun[]; cursor: SinceCursor }> {
    const template = this.options.config.runsQuery ?? this.options.config.query
    if (template === undefined) return { runs: [], cursor: { token: '0' } }
    const lastId = Number(cursor?.token ?? '0') || 0
    const rows = await this.query(boundarySql(template, lastId), signal)
    const mapped: FleetRun[] = []
    let maxId = lastId
    for (const row of rows) {
      const run = runOfRow(row, this.notes.runs as string[])
      if (run !== undefined) mapped.push(run)
      const id = Number(row.id)
      if (Number.isFinite(id)) maxId = Math.max(maxId, id)
    }
    return { runs: mapped, cursor: { token: String(maxId) } }
  }

  /** Incremental errors from `errorsQuery` (falls back to the base `query`). */
  async fetchErrorEntries(cursor: SinceCursor | null, signal?: AbortSignal): Promise<{ entries: ErrorEntry[]; cursor: SinceCursor }> {
    void cursor
    const sql = this.options.config.errorsQuery ?? this.options.config.query
    if (sql === undefined) return { entries: [], cursor: { token: '0' } }
    const rows = await this.query(sql, signal)
    const entries: ErrorEntry[] = []
    for (const row of rows) {
      const entry = errorOfRow(row, this.id, this.options.secrets ?? [], this.notes.errors as string[])
      if (entry !== undefined) entries.push(entry)
    }
    return { entries, cursor: { token: String(new Date().toISOString()) } }
  }

  /** Connectivity probe through `stat` on the configured database. */
  async health(signal?: AbortSignal): Promise<SourceHealth> {
    const startedAt = (this.options.now ?? (() => new Date()))().getTime()
    const result = await this.options.run({ kind: 'stat', format: '%d %i %s', path: this.dbPath }, signal)
    const elapsed = (this.options.now ?? (() => new Date()))().getTime() - startedAt
    const checkedAt = new Date().toISOString()
    if (result.code !== 0) {
      return { sourceId: this.id, state: 'down', latencyMs: elapsed, checkedAt, consecutiveFailures: 1, message: `stat failed rc=${String(result.code)}` }
    }
    const mark = markOf(result.stdout, 0)
    this.log(`ssh-sqlite ${this.id}: db present size=${String(mark.size)}`)
    return { sourceId: this.id, state: 'up', latencyMs: elapsed, checkedAt, consecutiveFailures: 0, message: null }
  }
}
