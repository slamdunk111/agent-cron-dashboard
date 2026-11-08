/**
 * Grading of snapshot pairs into change kinds (P4, plan §2).
 *
 * A pure function layer: no storage, no clock, no network. The engine feeds it
 * one {@link SnapshotPair} and gets back every graded change that pair proves.
 * The severity of each kind is **not** re-declared here — it is read from the
 * frozen table (`CHANGE_LEVELS` in `contracts/events.ts`) so a contract edit is
 * the only way to change a grade.
 *
 * First-observation kinds (`pr-seeded`, `issue-seeded`) come from the ADRs:
 * `before === null` produces exactly one such kind, and the notifier must skip
 * it (ADR P2-1, ADR P3-1). The table therefore marks them digest-only.
 */
import { CHANGE_LEVELS, type ChangeEvidence, type ChangeKind, type ChangeLevel } from '../../../../contracts/events.ts'
import type { PrSnapshot, IssueSnapshot } from '../../../../contracts/records.ts'

/** One graded change a pair proves, before it becomes a `ChangeEvent`. */
export interface GradedChange {
  readonly kind: ChangeKind
  /** Read from the frozen table, never from a local copy. */
  readonly level: ChangeLevel
  readonly evidence: readonly ChangeEvidence[]
  /** Locale-neutral one-line summary built from the evidence. */
  readonly summary: string
}

/** First-observation kinds (never merged, never dispatched; ADR P2-1 / P3-1). */
export const FIRST_OBSERVATION_KINDS: readonly ChangeKind[] = ['pr-seeded', 'issue-seeded']

/** Every community kind this engine may emit, in table order (used by the gate's seed rows). */
export const COMMUNITY_RULES: readonly ChangeKind[] = [
  'pr-seeded',
  'pr-merged',
  'pr-closed',
  'pr-conflicting',
  'pr-ci-failed',
  'pr-review-changes-requested',
  'pr-draft-ready',
  'pr-ci-green',
  'pr-review-comment',
  'issue-seeded',
  'issue-closed',
  'issue-reopened',
  'issue-labeled',
  'issue-assigned',
  'issue-comment',
]

/** Fleet kinds: in the frozen table, produced by P5/P6 — never by this engine. */
export const FLEET_KINDS: readonly ChangeKind[] = [
  'run-failed',
  'run-recovered',
  'source-health-down',
  'source-health-recovered',
  'error-record-opened',
  'error-record-reopened',
  'error-record-verified',
]

/** Evidence field name used when a merged event's evidence list was capped. */
export const EVIDENCE_CAP_TRUNCATION_MARKER = 'evidenceTruncated'

/** Whether a kind is a first-observation kind (never dispatched, never merged). */
export function isFirstObservation(kind: ChangeKind): boolean {
  return FIRST_OBSERVATION_KINDS.includes(kind)
}

function graded(kind: ChangeKind, evidence: readonly ChangeEvidence[], summary: string): GradedChange {
  return { kind, level: CHANGE_LEVELS[kind], evidence, summary }
}

function field(before: unknown, after: unknown): ChangeEvidence {
  return { field: 'value', before, after }
}

/** Evidence entry with an explicit field name. */
function ev(name: string, before: unknown, after: unknown): ChangeEvidence {
  return { field: name, before, after }
}

/** Whether two string arrays hold the same members (order-insensitive). */
function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
}

/** Entries present in `after` but not in `before`. */
function added(before: readonly string[], after: readonly string[]): string[] {
  return after.filter((entry) => !before.includes(entry))
}

/** Entries present in `before` but gone from `after`. */
function removed(before: readonly string[], after: readonly string[]): string[] {
  return before.filter((entry) => !after.includes(entry))
}

/**
 * Grade one PR snapshot pair (plan §2.1).
 * @param before - previous snapshot, `null` on first observation.
 * @param after - snapshot the poll produced.
 * @returns every graded change; empty when nothing graded moved.
 */
export function gradePair(before: PrSnapshot | null, after: PrSnapshot): GradedChange[] {
  if (before === null) {
    return [graded('pr-seeded', [ev('firstSeenAt', null, after.firstSeenAt)], `first observation: ${after.state}`)]
  }
  const out: GradedChange[] = []
  // Terminal state wins alone: a merged/closed PR cannot also report CI.
  if (before.state !== after.state) {
    if (after.state === 'merged') out.push(graded('pr-merged', [ev('state', before.state, after.state)], `merged (${before.state} -> merged)`))
    else if (after.state === 'closed') out.push(graded('pr-closed', [ev('state', before.state, after.state)], `closed (${before.state} -> closed)`))
    if (out.length > 0) return out
  }
  const open = after.state === 'open'
  if (open && before.mergeability !== after.mergeability && after.mergeability === 'conflicting') {
    out.push(graded('pr-conflicting', [ev('mergeability', before.mergeability, after.mergeability)], 'mergeable -> conflicting'))
  }
  if (open && before.checksRollup !== after.checksRollup && after.checksRollup === 'failure') {
    out.push(graded('pr-ci-failed', [ev('checksRollup', before.checksRollup, after.checksRollup)], `checks ${before.checksRollup} -> failure`))
  }
  if (open && before.reviewDecision !== after.reviewDecision && after.reviewDecision === 'changes-requested') {
    out.push(
      graded('pr-review-changes-requested', [ev('reviewDecision', before.reviewDecision, after.reviewDecision)], `review ${before.reviewDecision} -> changes-requested`),
    )
  }
  if (open && before.draft !== after.draft && after.draft === false) {
    out.push(graded('pr-draft-ready', [ev('draft', before.draft, after.draft)], 'draft -> ready for review'))
  }
  if (open && before.checksRollup !== after.checksRollup && after.checksRollup === 'success') {
    out.push(graded('pr-ci-green', [ev('checksRollup', before.checksRollup, after.checksRollup)], `checks ${before.checksRollup} -> success`))
  }
  // A review comment has no counter in the P2 snapshot (D2): the only signal is
  // the host update stamp moving while the verdict and the checks stand still.
  if (open && before.updatedAt !== after.updatedAt && before.reviewDecision === after.reviewDecision && before.checksRollup === after.checksRollup && before.headSha === after.headSha) {
    out.push(
      graded(
        'pr-review-comment',
        [ev('updatedAt', before.updatedAt, after.updatedAt), ev('headSha', before.headSha, after.headSha)],
        'updated without a verdict or check change (signal=updated-moved)',
      ),
    )
  }
  return out
}

/**
 * Grade one issue snapshot pair (plan §2.2).
 * @param before - previous snapshot, `null` on first observation.
 * @param after - snapshot the poll produced.
 * @param foreign - whether the last comment came from somebody else
 *   (`isForeignReply` of P3); `null` when no comment read happened.
 * @returns every graded change; empty when nothing graded moved.
 */
export function gradeIssuePair(before: IssueSnapshot | null, after: IssueSnapshot, foreign: boolean | null): GradedChange[] {
  if (before === null) {
    return [graded('issue-seeded', [ev('firstSeenAt', null, after.firstSeenAt)], `first observation: ${after.state}`)]
  }
  const out: GradedChange[] = []
  if (before.state !== after.state) {
    out.push(
      after.state === 'closed'
        ? graded('issue-closed', [ev('state', before.state, after.state)], 'issue closed')
        : graded('issue-reopened', [ev('state', before.state, after.state)], 'issue reopened'),
    )
  }
  if (!sameSet(before.labels, after.labels)) {
    const plus = added(before.labels, after.labels)
    const minus = removed(before.labels, after.labels)
    out.push(
      graded(
        'issue-labeled',
        [ev('labels', before.labels, after.labels), ev('labelsAdded', [], plus), ev('labelsRemoved', [], minus)],
        `labels +${plus.length}/-${minus.length}`,
      ),
    )
  }
  if (!sameSet(before.assignees, after.assignees)) {
    const plus = added(before.assignees, after.assignees)
    const minus = removed(before.assignees, after.assignees)
    out.push(
      graded(
        'issue-assigned',
        [ev('assignees', before.assignees, after.assignees), ev('assigneesAdded', [], plus), ev('assigneesRemoved', [], minus)],
        `assignees +${plus.length}/-${minus.length}`,
      ),
    )
  }
  // A new reply changes the comment count; the commenter tells whose reply it is.
  if (after.comments > before.comments) {
    out.push(
      graded(
        'issue-comment',
        [ev('comments', before.comments, after.comments), ev('lastCommentBy', before.lastCommentBy, after.lastCommentBy)],
        foreign === true ? `reply by ${after.lastCommentBy ?? 'unknown'}` : `new comment (self/unknown: ${after.lastCommentBy ?? 'unknown'})`,
      ),
    )
  }
  return out
}

/** Grade one pair by scope name; `fleet` pairs are not this engine's input. */
export function gradeChanges(kind: 'pr' | 'issue', before: unknown, after: unknown, foreign: boolean | null = null): GradedChange[] {
  if (kind === 'pr') return gradePair(before as PrSnapshot | null, after as PrSnapshot)
  return gradeIssuePair(before as IssueSnapshot | null, after as IssueSnapshot, foreign)
}

/** Evidence entry of one value-only pair (kept exported for the engine's synthetic events). */
export { field as valueEvidence }
