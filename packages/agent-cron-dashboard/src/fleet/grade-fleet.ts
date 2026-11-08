/**
 * Fleet grading (P5, plan §3.6) — pure functions, no storage, no clock.
 *
 * Only the four P5 keys can be produced here: `run-failed`, `run-recovered`,
 * `source-health-down`, `source-health-recovered`. The `error-record-*` keys stay
 * reserved for P6's ErrorPipeline (ADR P5-1 item 5) and are asserted absent by
 * `test/fleet-grade.test.ts`.
 */
import { CHANGE_LEVELS, type ChangeEvidence, type ChangeKind, type ChangeLevel } from '../../../../contracts/events.ts'
import type { FleetJob, FleetRun, FleetRunStatus } from '../../../../contracts/fleet-source.ts'
import type { SourceHealth as FleetSourceHealth } from '../../../../contracts/records.ts'

/** One graded fleet change before it becomes a `ChangeEvent`. */
export interface FleetGraded {
  readonly kind: ChangeKind
  readonly level: ChangeLevel
  readonly evidence: readonly ChangeEvidence[]
  readonly summary: string
}

/** Keys P5 may emit (subset of the frozen table). */
export const P5_EMITTABLE_KINDS = ['run-failed', 'run-recovered', 'source-health-down', 'source-health-recovered'] as const satisfies readonly ChangeKind[]

/** Keys reserved for P6, derived from the frozen table so a table edit cannot drift. */
export const P6_RESERVED_KINDS: readonly ChangeKind[] = (
  Object.keys(CHANGE_LEVELS) as ChangeKind[]
).filter((kind) => kind.startsWith('error-record-'))

/** Storage key of a run/job subject (`<sourceId>/<jobId>`, design §8). */
export function runKey(sourceId: string, run: FleetRun, job?: FleetJob): string {
  void job
  return `${sourceId}/${run.jobId}`
}

/** Storage key of a health subject (`<sourceId>`). */
export function healthKey(sourceId: string): string {
  return sourceId
}

function graded(kind: ChangeKind, evidence: readonly ChangeEvidence[], summary: string): FleetGraded {
  return { kind, level: CHANGE_LEVELS[kind], evidence, summary }
}

/**
 * Grade one run status transition.
 * @param before - the job's previously stored status (`null` on first observation).
 * @param after - the status of the run just pulled.
 * @param jobId - subject id for the summary and evidence.
 * @returns at most one graded change; a first observation only records a baseline.
 */
export function gradeRun(before: FleetRunStatus | null, after: FleetRunStatus, jobId: string): FleetGraded[] {
  if (before === null || before === after) return []
  if (after === 'failed') return [graded('run-failed', [{ field: 'lastStatus', before, after }], `${jobId}: ${before} -> failed`)]
  if (after === 'ok' && before === 'failed') return [graded('run-recovered', [{ field: 'lastStatus', before, after }], `${jobId}: failed -> ok`)]
  return []
}

/**
 * Grade one health transition.
 * @param before - previously stored health (`null` on first observation).
 * @param after - health just measured.
 * @returns at most one graded change; `disabled` never produces one.
 */
export function gradeHealth(before: FleetSourceHealth | null, after: FleetSourceHealth): FleetGraded[] {
  if (before === null || before.state === after.state) return []
  if (after.state === 'down' && (before.state === 'up' || before.state === 'degraded')) {
    return [graded('source-health-down', [{ field: 'state', before: before.state, after: after.state }], `${after.sourceId}: ${before.state} -> down${after.message === null ? '' : ` (${after.message})`}`)]
  }
  if (after.state === 'up' && (before.state === 'down' || before.state === 'degraded')) {
    return [graded('source-health-recovered', [{ field: 'state', before: before.state, after: after.state }], `${after.sourceId}: ${before.state} -> up`)]
  }
  return []
}
