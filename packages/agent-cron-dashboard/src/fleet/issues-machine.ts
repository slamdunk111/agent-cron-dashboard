/**
 * IssueRecord state machine (P6 task 4, design §5.4).
 *
 *    open ──(analysis done)──▶ analyzed ──(repair registered)──▶ fix-applied
 *      │                                                             │
 *      │                                         greenStreak >= N ───┴──▶ verified-resolved
 *      └──▶ closed-wontfix    verified-resolved ──(recurrence)──▶ reopened ──▶ …
 *
 * The legal edges live in one frozen table; anything else throws
 * {@link IllegalTransitionError}. The verification read is the caller's job: this
 * module only compares the streak number it is handed (`FleetJobRecord.greenStreak`,
 * maintained by the P5 watch) against the configured threshold.
 */
import type { IssueAnalysis, IssueRecord, IssueRecordState, ResolutionStep } from '../../../../contracts/records.ts'

/** Every state of the contract, in lifecycle order. */
export const ISSUE_STATES = ['open', 'analyzed', 'fix-applied', 'verified-resolved', 'closed-wontfix', 'reopened'] as const satisfies readonly IssueRecordState[]

/** The frozen legal edges; every state appears, states without an exit list an empty array. */
export const LEGAL_TRANSITIONS: Readonly<Record<IssueRecordState, readonly IssueRecordState[]>> = Object.freeze({
  open: ['analyzed', 'closed-wontfix'],
  analyzed: ['fix-applied', 'closed-wontfix'],
  'fix-applied': ['verified-resolved', 'reopened', 'closed-wontfix'],
  'verified-resolved': ['reopened'],
  'closed-wontfix': ['reopened'],
  reopened: ['analyzed', 'fix-applied', 'closed-wontfix'],
})

/** Raised when a transition is not in {@link LEGAL_TRANSITIONS}. */
export class IllegalTransitionError extends Error {
  readonly from: IssueRecordState
  readonly to: IssueRecordState

  constructor(from: IssueRecordState, to: IssueRecordState) {
    super(`illegal IssueRecord transition ${from} -> ${to}`)
    this.name = 'IllegalTransitionError'
    this.from = from
    this.to = to
  }
}

/**
 * Whether the edge exists.
 * @param from - current state.
 * @param to - target state.
 */
export function canTransition(from: IssueRecordState, to: IssueRecordState): boolean {
  return LEGAL_TRANSITIONS[from].includes(to)
}

/**
 * Throw {@link IllegalTransitionError} unless the edge exists.
 * @param from - current state.
 * @param to - target state.
 */
export function assertTransition(from: IssueRecordState, to: IssueRecordState): IssueRecordState {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to)
  return to
}

/**
 * Build one timeline element.
 * @param kind - which step.
 * @param at - ISO 8601 instant.
 * @param by - actor (`ui`, `tool`, `scheduler`).
 * @param note - free-form note.
 */
export function stepOf(kind: ResolutionStep['kind'], at: string, by: string, note: string | null): ResolutionStep {
  return { kind, at, by, note }
}

/** Previous state a step starts from, when the step names one. */
const STEP_TARGET: Readonly<Record<ResolutionStep['kind'], IssueRecordState | null>> = Object.freeze({
  'fix-applied': 'fix-applied',
  wontfix: 'closed-wontfix',
  reopened: 'reopened',
  green: null,
})

/** States an agreement step may start from (the legal edge source states). */
function sourcesOf(to: IssueRecordState): IssueRecordState[] {
  return ISSUE_STATES.filter((state) => canTransition(state, to))
}

/**
 * Apply one human/UI step to a record.
 *
 * `green` steps record the verification observation without moving the state
 * (the move is {@link maybeVerify}'s decision); every other step moves the record
 * and rejects an illegal edge.
 * @param record - the stored record.
 * @param step - the step to append.
 * @returns a new record (the input is never mutated).
 */
export function applyStep(record: IssueRecord, step: ResolutionStep): IssueRecord {
  if (step.kind === 'green') {
    if (record.state !== 'fix-applied') throw new IllegalTransitionError(record.state, 'fix-applied')
    return { ...record, resolution: [...record.resolution, step] }
  }
  const target = STEP_TARGET[step.kind]
  if (target === null) throw new IllegalTransitionError(record.state, record.state)
  const sources = sourcesOf(target)
  if (!sources.includes(record.state)) throw new IllegalTransitionError(record.state, target)
  return { ...record, state: target, resolution: [...record.resolution, step] }
}

/**
 * Decide whether a record waiting for verification may be resolved.
 *
 * Only `fix-applied` records move; the evidence is the consecutive-green count
 * the caller read from `workbench.fleet.jobs`.
 * @param record - the stored record.
 * @param greenStreak - consecutive `ok` runs of the record's job.
 * @param threshold - configured `analysis.greenRunsToVerify`.
 * @param at - ISO 8601 instant of the decision (defaults to the last sample's instant when absent).
 * @returns the same record when the streak is short or the state is not `fix-applied`.
 */
export function maybeVerify(record: IssueRecord, greenStreak: number, threshold: number, at?: string): IssueRecord {
  if (!Number.isInteger(threshold) || threshold < 1) throw new RangeError(`verification threshold must be a positive integer, got ${String(threshold)}`)
  if (record.state !== 'fix-applied' || greenStreak < threshold) return record
  const verifiedAt = at ?? new Date().toISOString()
  return {
    ...record,
    state: assertTransition(record.state, 'verified-resolved'),
    verifiedAt,
    resolution: [...record.resolution, stepOf('green', verifiedAt, 'scheduler', `streak=${String(greenStreak)}`)],
  }
}

/** The model output the analyser validated (design §5.4 / `config.schema.json` `$defs.analysisOutput`). */
export interface AnalysisPayload {
  readonly rootCauseHypothesis: string
  readonly impact: string
  readonly suggestedFix: readonly string[]
  readonly confidence: number
  readonly needMoreInfo: readonly string[]
  /** Model identifier that produced the payload. */
  readonly model: string
}

/**
 * Attach a finished analysis: `open`/`reopened` records move to `analyzed`.
 * @param record - the stored record.
 * @param payload - the validated analysis.
 * @param at - ISO 8601 instant of completion.
 */
export function recordWithAnalysis(record: IssueRecord, payload: AnalysisPayload, at: string): IssueRecord {
  const state = record.state === 'open' || record.state === 'reopened' ? assertTransition(record.state, 'analyzed') : record.state
  const analysis: IssueAnalysis = {
    state: 'done',
    rootCauseHypothesis: payload.rootCauseHypothesis,
    impact: payload.impact,
    suggestedFix: [...payload.suggestedFix],
    confidence: payload.confidence,
    needMoreInfo: [...payload.needMoreInfo],
    analyzedAt: at,
    model: payload.model,
  }
  return { ...record, state, analysis }
}
