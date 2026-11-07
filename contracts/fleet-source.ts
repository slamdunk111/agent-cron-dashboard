/**
 * Fleet source contracts (P0 freeze).
 *
 * Canonical source of truth for the Fleet (cron/scheduled-task) side of the
 * workbench. Every adapters written by later plans (P5: hermes-ssh,
 * jiuwenswarm-local, generic ssh-sqlite) implements {@link FleetSource}; the
 * FleetWatchService consumes only this surface. Changing any exported shape
 * here requires an ADR under `contracts/adr/` (see 母纲 §6).
 */
import type { SourceHealth } from './records.ts'

/** Kinds of fleet sources a configuration may declare. */
export type FleetSourceKind = 'hermes-ssh' | 'jiuwenswarm-local' | 'ssh-sqlite'

/** Connection settings of an SSH-backed source. `host` follows the host ssh config alias. */
export interface FleetSshConfig {
  /** ssh alias/host (e.g. `nas`). Never carries credentials; keys stay in the host ssh config. */
  readonly host: string
  /** SQLite database path on the remote host (read-only access only). */
  readonly dbPath?: string
  /** Remote error-log path, when the source exposes one. */
  readonly errorsLog?: string
  /** Extra ssh options appended to the fixed command template (validated by the adapter). */
  readonly sshOptions?: readonly string[]
}

/** Connection settings of a local (same machine) source. */
export interface FleetLocalPaths {
  /** Root state directory of the local service (e.g. `~/.jiuwenswarm`). */
  readonly state: string
}

/** One declarative fleet source, as found in `workbench.config.fleet[]`. */
export interface FleetSourceConfig {
  /** Stable source id used as storage key prefix, e.g. `hermes-nas`. */
  readonly id: string
  /** Adapter kind. */
  readonly kind: FleetSourceKind
  /** Human readable label (falls back to `id`). */
  readonly label?: string
  /** Present for `hermes-ssh` and `ssh-sqlite`. */
  readonly ssh?: FleetSshConfig
  /** Present for `jiuwenswarm-local`. */
  readonly paths?: FleetLocalPaths
  /** Enabled flag; disabled sources are reported as `down`/`disabled` and never polled. */
  readonly enabled?: boolean
}

/** A scheduled job definition as reported by a source. */
export interface FleetJob {
  /** Source-local job id (`job_id` for hermes, prompt file stem for jiuwenswarm). */
  readonly id: string
  /** Display name (job definition name when known, else the id). */
  readonly name: string
  /** Cron/rrule expression when the source exposes it. */
  readonly schedule: string | null
  /** Script/entry path when exposed. */
  readonly script: string | null
  /** ISO 8601 of the most recent run start known to the source, or null when never run. */
  readonly lastRunAt: string | null
  /** Status of the most recent run, or null when unknown. */
  readonly lastStatus: FleetRunStatus | null
}

/** Outcome of one job run. */
export type FleetRunStatus = 'ok' | 'failed' | 'timeout' | 'running'

/** One job run record. */
export interface FleetRun {
  readonly jobId: string
  /** ISO 8601 start time. */
  readonly startedAt: string
  /** ISO 8601 finish time, absent while running or when the source only reports start. */
  readonly finishedAt?: string
  readonly status: FleetRunStatus
  /** Free-form exit detail (exit code, error summary). */
  readonly exitDetail?: string
}

/** Severity of one error entry. */
export type ErrorSeverity = 'info' | 'warning' | 'error' | 'critical'

/** One raw error observation pushed by a source (pre-fingerprint). */
export interface ErrorEntry {
  /** Source id that produced the entry. */
  readonly sourceId: string
  /** Job id when the entry can be attributed to a job. */
  readonly jobId?: string
  /** ISO 8601 occurrence time. */
  readonly occurredAt: string
  readonly severity: ErrorSeverity
  /** Masked message (secret-mask applied before crossing this boundary). */
  readonly message: string
  /** Where the raw text came from: sqlite row id, log path + offset, etc. */
  readonly raw: string
}

/** Incremental pull boundary for one stream of a source. */
export interface SinceCursor {
  /** Adapter-defined cursor token for the stream (`id` for sqlite, byte offset for logs, ETag for HTTP). */
  readonly token: string
}

/**
 * Adapter contract. Implementations must be read-only against their sources:
 * SQL only through `file:...?mode=ro` URIs, logs only through tail/stats, and
 * local services only through status queries. A failing source must never
 * throw out of the watch loop: return failures inside {@link SourceHealth}.
 */
export interface FleetSource {
  /** Stable source id (`FleetSourceConfig.id`). */
  readonly id: string
  /** Adapter kind. */
  readonly kind: FleetSourceKind
  /** Job definitions (id/name/schedule/lastRun). */
  listJobs(signal?: AbortSignal): Promise<FleetJob[]>
  /**
   * Incremental run records. The adapter returns runs strictly after `cursor`
   * and the cursor to persist for the next call.
   */
  fetchRuns(cursor: SinceCursor | null, signal?: AbortSignal): Promise<{ runs: FleetRun[]; cursor: SinceCursor }>
  /** Incremental error entries with their next cursor. */
  fetchErrorEntries(cursor: SinceCursor | null, signal?: AbortSignal): Promise<{ entries: ErrorEntry[]; cursor: SinceCursor }>
  /** Connectivity / credentials / latency report for this source. */
  health(signal?: AbortSignal): Promise<SourceHealth>
}
