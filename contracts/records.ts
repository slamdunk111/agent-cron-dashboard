/**
 * Record contracts (P0 freeze).
 *
 * Stored record shapes shared by every plan that reads `workbench.*` storage
 * domains. `SnapshotStore` writes them, the tools (P4/P6) and the UI (P7)
 * read them, so the shape is frozen here rather than per consumer.
 */
import type { ChangeEvent } from './events.ts'
import type { FleetRunStatus } from './fleet-source.ts'

/** Community platform a snapshot belongs to. */
export type Platform = 'github' | 'gitcode'

/** Which kind of community item a snapshot describes. */
export type CommunityKind = 'pr' | 'issue'

/** Snapshot of one pull/merge request, stored at `workbench.snapshot.pr` key `<platform>/<owner>/<repo>/<number>`. */
export interface PrSnapshot {
  readonly platform: Platform
  readonly owner: string
  readonly repo: string
  readonly number: number
  readonly title: string
  readonly state: 'open' | 'closed' | 'merged'
  readonly draft: boolean
  readonly mergeability: 'mergeable' | 'conflicting' | 'unknown'
  readonly reviewDecision: 'approved' | 'changes-requested' | 'review-required' | 'none'
  readonly checksRollup: 'none' | 'pending' | 'success' | 'failure'
  readonly headSha: string
  /** ISO 8601 of the host's last update. */
  readonly updatedAt: string
  /** ISO 8601 of the first observation by this plugin (seeding does not notify on it). */
  readonly firstSeenAt: string
  /** ISO 8601 of the last observation. */
  readonly lastSeenAt: string
  /** Ring buffer (max 50, newest last) of graded events. */
  readonly events: readonly ChangeEvent[]
}

/** Snapshot of one issue, stored at `workbench.snapshot.issue` key `<platform>/<owner>/<repo>/<number>`. */
export interface IssueSnapshot {
  readonly platform: Platform
  readonly owner: string
  readonly repo: string
  readonly number: number
  readonly title: string
  readonly state: 'open' | 'closed'
  readonly labels: readonly string[]
  readonly assignees: readonly string[]
  /** Comment count reported by the host. */
  readonly comments: number
  /** ISO 8601 of the host's last update. */
  readonly updatedAt: string
  /** Login of the last commenter, or null when unknown. */
  readonly lastCommentBy: string | null
  /** ISO 8601 of the last comment, or null when unknown. */
  readonly lastCommentAt: string | null
  readonly firstSeenAt: string
  readonly lastSeenAt: string
  readonly events: readonly ChangeEvent[]
}

/** Job definition plus its most recent run, stored at `workbench.fleet.jobs` key `<sourceId>/<jobId>`. */
export interface FleetJobRecord {
  readonly sourceId: string
  readonly jobId: string
  readonly name: string
  readonly schedule: string | null
  readonly script: string | null
  readonly lastRunAt: string | null
  readonly lastStatus: FleetRunStatus | null
  /** Consecutive `ok` runs since the last non-ok run; drives the verify rule of P6. */
  readonly greenStreak: number
  /** ISO 8601 of the last collection. */
  readonly collectedAt: string
}

/** Health report of one fleet source; also persisted inside `workbench.events`. */
export interface SourceHealth {
  readonly sourceId: string
  /** `up`: reachable; `down`: unreachable/unauthorised; `degraded`: reachable with partial failures; `disabled`: turned off in configuration. */
  readonly state: 'up' | 'down' | 'degraded' | 'disabled'
  /** Round-trip latency of the last probe in milliseconds, or null when not measured. */
  readonly latencyMs: number | null
  /** ISO 8601 of the probe. */
  readonly checkedAt: string
  /** Human readable cause when not `up`. */
  readonly message: string | null
  /** Consecutive failure count (drives exponential backoff). */
  readonly consecutiveFailures: number
}

/** Lifecycle state of an {@link IssueRecord} (design §5.4). */
export type IssueRecordState =
  | 'open'
  | 'analyzed'
  | 'fix-applied'
  | 'verified-resolved'
  | 'closed-wontfix'
  | 'reopened'

/** Status of the LLM analysis attached to a record. */
export type AnalysisState = 'pending' | 'running' | 'done' | 'failed'

/** LLM analysis output; the JSON Schema is frozen in `config.schema.json` `$defs.analysis`. */
export interface IssueAnalysis {
  readonly state: AnalysisState
  /** Root-cause hypothesis, human readable; null while pending. */
  readonly rootCauseHypothesis: string | null
  /** Impact statement, null while pending. */
  readonly impact: string | null
  /** Ordered remediation steps; empty while pending. */
  readonly suggestedFix: readonly string[]
  /** Model confidence in [0, 1]; null while pending. */
  readonly confidence: number | null
  /** Information the model needs to decide; empty when nothing is missing. */
  readonly needMoreInfo: readonly string[]
  /** ISO 8601 of the analysis completion, or null while pending. */
  readonly analyzedAt: string | null
  /** Model identifier that produced the analysis, or null. */
  readonly model: string | null
}

/** One element of the resolution timeline. */
export interface ResolutionStep {
  /** `fix-applied`: repair registered; `green`: verification run; `reopened`: recurrence; `wontfix`: dismissed. */
  readonly kind: 'fix-applied' | 'green' | 'reopened' | 'wontfix'
  /** ISO 8601 of the step. */
  readonly at: string
  /** Who/what recorded it: `ui`, `tool`, `scheduler`. */
  readonly by: string
  /** Free-form note (repair description, run id). */
  readonly note: string | null
}

/** One error sample (truncated, masked) kept in the record ring. */
export interface ErrorSample {
  readonly occurredAt: string
  readonly severity: string
  readonly message: string
}

/** Error record (issue ledger entry) stored at `workbench.fleet.errors` key `<recordId>`. */
export interface IssueRecord {
  readonly recordId: string
  /** Fingerprint signature; mirrored into `workbench.fingerprints`. */
  readonly signature: string
  readonly sourceId: string
  readonly jobId: string | null
  readonly state: IssueRecordState
  readonly severity: string
  /** Total occurrences observed. */
  readonly count: number
  /** ISO 8601 of the first occurrence. */
  readonly firstSeen: string
  /** ISO 8601 of the last occurrence. */
  readonly lastSeen: string
  /** Ring of the most recent samples (max 5). */
  readonly samples: readonly ErrorSample[]
  readonly analysis: IssueAnalysis
  readonly resolution: readonly ResolutionStep[]
  /** ISO 8601 when the record reached `verified-resolved`, or null. */
  readonly verifiedAt: string | null
}

/** Fingerprint index entry stored at `workbench.fingerprints` key `<signature>`. */
export interface FingerprintRecord {
  readonly signature: string
  readonly recordId: string
  readonly count: number
  /** ISO 8601 of the last occurrence. */
  readonly lastSeen: string
}

/** Incremental cursor stored at `workbench.cursors` key `<sourceId>:<stream>`. */
export interface CursorRecord {
  /** Adapter-defined token (`id` for sqlite, byte offset for logs, ETag for HTTP). */
  readonly token: string
  /** ISO 8601 of the last successful advance. */
  readonly updatedAt: string
}
