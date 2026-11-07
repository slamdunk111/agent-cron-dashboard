/**
 * Change-event contracts (P0 freeze).
 *
 * `ChangeEngine` (P4) turns snapshot pairs into {@link ChangeEvent}s, using
 * the severity table in the design document §4.4. Notification routing
 * consumes only `level` and `kind`, so adding a kind must be done here and
 * advertised through an ADR.
 */

/** Notification level: `high` goes to an action card, `medium` into the digest. */
export type ChangeLevel = 'high' | 'medium'

/** Community-side change kinds (PR + issue, design §4.4). */
export type CommunityChangeKind =
  | 'pr-ci-failed'
  | 'pr-review-changes-requested'
  | 'pr-conflicting'
  | 'pr-merged'
  | 'pr-closed'
  | 'pr-review-comment'
  | 'pr-draft-ready'
  | 'pr-ci-green'
  | 'issue-closed'
  | 'issue-reopened'
  | 'issue-labeled'
  | 'issue-assigned'
  | 'issue-comment'

/** Fleet-side change kinds (runs, health, error records). */
export type FleetChangeKind =
  | 'run-failed'
  | 'run-recovered'
  | 'source-health-down'
  | 'source-health-recovered'
  | 'error-record-opened'
  | 'error-record-reopened'
  | 'error-record-verified'

/** Every change kind the engine may emit. */
export type ChangeKind = CommunityChangeKind | FleetChangeKind

/** Domain a change belongs to, mirroring the `scope` argument of `workbench_status`. */
export type ChangeScope = 'community' | 'fleet'

/** Reference to the subject a change is about. */
export interface ChangeSubject {
  readonly scope: ChangeScope
  /** Storage key of the subject, e.g. `github/o/r/12`, `hermes-nas/68f64ca3b0b1`, `error/<recordId>`. */
  readonly key: string
  /** Human readable label (PR title, job name, error signature prefix). */
  readonly label: string
  /** Source/community id when the subject belongs to a fleet source. */
  readonly sourceId?: string
}

/** Machine evidence backing one change event: previous/next snapshot fields. */
export interface ChangeEvidence {
  /** Field or stream that changed. */
  readonly field: string
  /** Value before the change (JSON-serializable), null for first observation. */
  readonly before: unknown
  /** Value after the change. */
  readonly after: unknown
}

/** One graded change produced by the change engine. */
export interface ChangeEvent {
  /** `high` -> action card; `medium` -> digest. */
  readonly level: ChangeLevel
  readonly kind: ChangeKind
  readonly subject: ChangeSubject
  /** One-line, locale-neutral summary produced from evidence. */
  readonly summary: string
  /** Machine evidence entries; never empty. */
  readonly evidence: readonly ChangeEvidence[]
  /** ISO 8601 emit time. */
  readonly at: string
}

/** Static severity table used by {@link classifyChange}. Keys are change kinds. */
export const CHANGE_LEVELS: Readonly<Record<ChangeKind, ChangeLevel>> = Object.freeze({
  'pr-ci-failed': 'high',
  'pr-review-changes-requested': 'high',
  'pr-conflicting': 'high',
  'pr-merged': 'high',
  'pr-closed': 'high',
  'pr-review-comment': 'medium',
  'pr-draft-ready': 'medium',
  'pr-ci-green': 'medium',
  'issue-closed': 'medium',
  'issue-reopened': 'medium',
  'issue-labeled': 'medium',
  'issue-assigned': 'medium',
  'issue-comment': 'medium',
  'run-failed': 'high',
  'run-recovered': 'medium',
  'source-health-down': 'high',
  'source-health-recovered': 'medium',
  'error-record-opened': 'high',
  'error-record-reopened': 'high',
  'error-record-verified': 'medium',
})

/** Look up the notification level of a change kind. */
export function classifyChange(kind: ChangeKind): ChangeLevel {
  return CHANGE_LEVELS[kind]
}
