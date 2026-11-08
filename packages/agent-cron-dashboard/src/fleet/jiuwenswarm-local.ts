/**
 * Jiuwenswarm local adapter (P5, probes/jiuwenswarm.md).
 *
 * Measured landings: tasks in `<state>/agent/home/cron_jobs.json`, runs in
 * `<state>/agent/.checkpoint/cron_run_ledger.db` (`cron_runs`), errors in
 * `<state>/logs/tool.log` plus one `*.stderr.log` per worker under
 * `<state>/run/worker-logs/`. `cron_prompts/` is not read: the probe found the
 * source tree never references it (probes/jiuwenswarm.md §2).
 */
import type { ErrorEntry, ErrorSeverity, FleetJob, FleetRun, FleetRunStatus, SinceCursor } from '../../../../contracts/fleet-source.ts'
import type { SourceHealth } from '../../../../contracts/records.ts'
import type { FleetSource, FleetSourceConfig } from '../../../../contracts/fleet-source.ts'
import { redact } from '../community/identity.ts'
import { advance, parseLogLines, type FileMark } from './log-tail.ts'

/** State-relative paths measured on this machine. */
export const JIUWENSWARM_PATHS = {
  jobsJson: 'agent/home/cron_jobs.json',
  runLedger: 'agent/.checkpoint/cron_run_ledger.db',
  toolLog: 'logs/tool.log',
  workerLogs: 'run/worker-logs',
  toolLogWindowBytes: 262144,
  workerLogWindowBytes: 131072,
} as const

/** One `cron_runs` row. */
export interface JiuwenswarmRunRow {
  readonly run_id: string
  readonly job_id: string
  readonly state: string
  readonly started_at: number
  readonly ended_at: number | null
}

/** One `cron_jobs.json` entry. */
interface JiuwenswarmJobJson {
  readonly id?: unknown
  readonly name?: unknown
  readonly enabled?: unknown
  readonly expired?: unknown
  readonly cron_expr?: unknown
  readonly timezone?: unknown
  readonly updated_at?: unknown
}

/** Local file access, injected so tests replay fixtures without the real service. */
export interface LocalFiles {
  /** Read the tail of a file; `bytes` bounds the window. */
  readonly tail: (path: string, bytes: number) => Promise<{ code: number; text: string }>
  /** `stat` a path (`%d %i %s` fields). */
  readonly stat: (path: string, format: string) => Promise<{ code: number; text: string }>
  /** Directory listing. */
  readonly list: (path: string) => Promise<{ code: number; names: readonly string[] }>
  /** Run one read-only SQLite query through a read-only URI. */
  readonly sqlite: (dbPath: string, sql: string) => Promise<{ code: number; text: string }>
}

/** Service probe, injected (real systemd/http in production). */
export interface LocalServiceProbe {
  readonly isActive: () => Promise<{ active: boolean; message: string | null }>
}

/** Options of the adapter. */
export interface JiuwenswarmOptions {
  readonly config: FleetSourceConfig
  readonly files: LocalFiles
  readonly service: LocalServiceProbe
  readonly secrets?: readonly (string | undefined)[]
  readonly now?: () => Date
  readonly log?: (line: string) => void
}

/** Cursors persisted between calls. */
interface LocalCursors {
  readonly runs?: number
  readonly files?: Record<string, FileMark>
}

/** Map the ledger state to the contract vocabulary (no failure state was measured). */
export function statusOfRow(row: JiuwenswarmRunRow): FleetRunStatus {
  return row.state === 'finished' && row.ended_at !== null ? 'ok' : 'running'
}

/** Convert an epoch-second ledger row into a `FleetRun`. */
export function runOf(row: JiuwenswarmRunRow): FleetRun {
  const started = new Date(Number(row.started_at) * 1000).toISOString()
  const base: FleetRun = { jobId: row.job_id, startedAt: started, status: statusOfRow(row) }
  if (row.ended_at === null) return base
  return { ...base, finishedAt: new Date(Number(row.ended_at) * 1000).toISOString() }
}

/** The incremental ledger query (`started_at > last`). */
export function ledgerSql(lastStarted: number): string {
  return `SELECT run_id,job_id,state,started_at,ended_at FROM cron_runs WHERE started_at > ${String(lastStarted)} ORDER BY started_at`
}

/** The job-list shape (`cron_jobs.json`). */
export function jobOf(raw: JiuwenswarmJobJson, index: number): FleetJob {
  const id = typeof raw.id === 'string' ? raw.id : `job-${String(index)}`
  const name = typeof raw.name === 'string' && raw.name !== '' ? raw.name : id
  const annotations: string[] = []
  if (raw.enabled === false) annotations.push('disabled')
  if (raw.expired === true) annotations.push('expired')
  return {
    id,
    name: annotations.length === 0 ? name : `${name} (${annotations.join(', ')})`,
    schedule: typeof raw.cron_expr === 'string' ? raw.cron_expr : null,
    script: null,
    lastRunAt: null,
    lastStatus: null,
  }
}

/** Parse the `cron_jobs.json` payload. */
export function parseJobs(text: string): readonly JiuwenswarmJobJson[] {
  const parsed = JSON.parse(text) as { jobs?: unknown } | unknown[]
  const jobs = Array.isArray(parsed) ? parsed : Array.isArray((parsed as { jobs?: unknown }).jobs) ? (parsed as { jobs: unknown[] }).jobs : []
  return jobs as readonly JiuwenswarmJobJson[]
}

/** severity word → contract severity. */
function severityOf(level: string): ErrorSeverity {
  return level === 'error' ? 'error' : 'warning'
}

/**
 * The jiuwenswarm local adapter.
 */
export class JiuwenswarmLocalAdapter implements FleetSource {
  readonly id: string
  readonly kind = 'jiuwenswarm-local' as const
  private readonly options: JiuwenswarmOptions
  private readonly state: string
  private readonly secrets: readonly (string | undefined)[]

  constructor(options: JiuwenswarmOptions) {
    this.options = options
    this.id = options.config.id
    const paths = options.config.paths
    if (paths === undefined) throw new Error(`jiuwenswarm-local source ${options.config.id} has no paths block`)
    this.state = paths.state
    this.secrets = options.secrets ?? []
  }

  private path(relative: string): string {
    return `${this.state.replace(/^~/, '~')}/${relative}`
  }

  /** Service health: systemd user unit, with the message kept when down. */
  async health(signal?: AbortSignal): Promise<SourceHealth> {
    void signal
    const startedAt = this.nowMs()
    const probe = await this.options.service.isActive().catch((error: unknown): { active: boolean; message: string | null } => ({
      active: false,
      message: error instanceof Error ? error.message : String(error),
    }))
    const elapsed = this.nowMs() - startedAt
    const checkedAt = new Date().toISOString()
    return probe.active
      ? { sourceId: this.id, state: 'up', latencyMs: elapsed, checkedAt, consecutiveFailures: 0, message: null }
      : { sourceId: this.id, state: 'down', latencyMs: elapsed, checkedAt, consecutiveFailures: 1, message: probe.message ?? 'unit is not active' }
  }

  /** Task list from `agent/home/cron_jobs.json`. */
  async listJobs(signal?: AbortSignal): Promise<FleetJob[]> {
    void signal
    const path = this.path(JIUWENSWARM_PATHS.jobsJson)
    const read = await this.options.files.tail(path, 1_048_576)
    if (read.code !== 0) throw new Error(`cron_jobs.json read failed rc=${String(read.code)}`)
    return parseJobs(read.text).map((entry, index) => jobOf(entry, index))
  }

  /** Incremental run ledger from `cron_run_ledger.db`. */
  async fetchRuns(cursor: SinceCursor | null, signal?: AbortSignal): Promise<{ runs: FleetRun[]; cursor: SinceCursor }> {
    void signal
    const state = cursor === null ? {} : parseCursor(cursor.token)
    const last = state.runs ?? 0
    const result = await this.options.files.sqlite(this.path(JIUWENSWARM_PATHS.runLedger), ledgerSql(last))
    if (result.code !== 0) throw new Error(`cron_run_ledger read failed rc=${String(result.code)}`)
    const rows = parseSqliteJson<JiuwenswarmRunRow>(result.text)
    const maxStarted = rows.reduce((max, row) => Math.max(max, Number(row.started_at)), last)
    return { runs: rows.map(runOf), cursor: { token: JSON.stringify({ ...state, runs: maxStarted }) } }
  }

  /** Incremental errors from `logs/tool.log` plus one offset per worker stderr file. */
  async fetchErrorEntries(cursor: SinceCursor | null, signal?: AbortSignal): Promise<{ entries: ErrorEntry[]; cursor: SinceCursor }> {
    void signal
    const state = cursor === null ? {} : parseCursor(cursor.token)
    const marks: Record<string, FileMark> = { ...(state.files ?? {}) }
    const entries: ErrorEntry[] = []
    const toolLog = this.path(JIUWENSWARM_PATHS.toolLog)
    const tool = await this.readFile(toolLog, marks[toolLog] ?? null, JIUWENSWARM_PATHS.toolLogWindowBytes, 'mixed', signal)
    if (tool !== undefined) {
      marks[toolLog] = tool.next
      entries.push(...tool.entries)
    }
    const dir = this.path(JIUWENSWARM_PATHS.workerLogs)
    const listing = await this.options.files.list(dir)
    if (listing.code === 0) {
      for (const name of listing.names.filter((entry) => entry.endsWith('.stderr.log'))) {
        const path = `${dir}/${name}`
        const read = await this.readFile(path, marks[path] ?? null, JIUWENSWARM_PATHS.workerLogWindowBytes, 'mixed', signal)
        if (read === undefined) continue
        marks[path] = read.next
        entries.push(...read.entries)
      }
    }
    return { entries, cursor: { token: JSON.stringify({ ...state, files: marks }) } }
  }

  private nowMs(): number {
    return (this.options.now ?? (() => new Date()))().getTime()
  }

  /** Read one file's tail, advance its offset and map error/warning lines. */
  private async readFile(path: string, mark: FileMark | null, windowBytes: number, shape: 'mixed', signal?: AbortSignal): Promise<{ entries: ErrorEntry[]; next: FileMark } | undefined> {
    void signal
    const stat = await this.options.files.stat(path, '%d %i %s')
    if (stat.code !== 0) return undefined
    const parts = stat.text.trim().split(/\s+/)
    const inode = parts.length >= 2 ? `${parts[0]}.${parts[1]}` : 'unknown'
    const size = Number(parts[2] ?? 0)
    const tail = await this.options.files.tail(path, windowBytes)
    if (tail.code !== 0) return undefined
    const result = advance(mark, { size, inode }, tail.text, windowBytes)
    if (result.rotated) this.options.log?.(`jiuwenswarm ${this.id}: ${path} rotated (offset reset)`)
    if (result.dropped) this.options.log?.(`jiuwenswarm ${this.id}: ${path} window overflow (dropped bytes counted)`)
    const entries: ErrorEntry[] = []
    for (const line of parseLogLines(shape, result.text.split('\n'))) {
      if (line.level !== 'error' && line.level !== 'warning' && line.level !== 'critical') continue
      entries.push({
        sourceId: this.id,
        occurredAt: line.occurredAt,
        severity: severityOf(line.level),
        message: redact(line.message, this.secrets),
        raw: `${path}@${String(result.offset)}`,
      })
    }
    return { entries, next: result.next }
  }
}

/** Parse a cursor token defensively. */
function parseCursor(token: string): LocalCursors {
  try {
    return JSON.parse(token) as LocalCursors
  } catch {
    return {}
  }
}

/** Parse a `sqlite3 -json` payload. */
export function parseSqliteJson<T>(text: string): T[] {
  const trimmed = text.trim()
  if (trimmed === '') return []
  const parsed: unknown = JSON.parse(trimmed)
  return Array.isArray(parsed) ? (parsed as T[]) : [parsed as T]
}
