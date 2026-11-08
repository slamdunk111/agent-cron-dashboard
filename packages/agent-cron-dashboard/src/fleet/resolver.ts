/**
 * Resolver (P6 task 5, design §5.4): the three write channels converge here —
 * the UI form, the `workbench_resolve` tool, and an agent calling that tool in
 * conversation — all of them reduce to {@link resolve}.
 *
 * The resolver never decides on its own: it applies a state-machine step, keeps
 * the recurrence count, emits the matching `error-record-*` event when the state
 * actually changed, and returns text the tool shows verbatim.
 */
import type { IssueRecord } from '../../../../contracts/records.ts'
import { IllegalTransitionError, applyStep, stepOf } from './issues-machine.ts'
import type { ErrorPipeline } from './error-pipeline.ts'

/** The actions a human (or an agent on their behalf) may register. */
export type ResolveAction = 'fix-applied' | 'wontfix' | 'reopen'

/** Every accepted action, in the order the tool lists them. */
export const RESOLVE_ACTIONS: readonly ResolveAction[] = ['fix-applied', 'wontfix', 'reopen']

/** Request of one resolution. */
export interface ResolveRequest {
  readonly recordId: string
  readonly action: ResolveAction
  readonly note?: string
  /** Actor label stored in the timeline (`tool`, `ui`, `agent`). */
  readonly by?: string
}

/** Outcome of one resolution. */
export interface ResolveOutcome {
  readonly ok: boolean
  readonly text: string
  /** Record key that changed, or null when nothing was written. */
  readonly subjectKey: string | null
  readonly record: IssueRecord | null
}

/** Map the tool action to the timeline step kind. */
const STEP_KIND: Readonly<Record<ResolveAction, 'fix-applied' | 'wontfix' | 'reopened'>> = Object.freeze({
  'fix-applied': 'fix-applied',
  wontfix: 'wontfix',
  reopen: 'reopened',
})

/** One-line state badge used by the tool text. */
export function stateBadge(record: IssueRecord): string {
  const alreadyVerified = record.verifiedAt !== null && record.state === 'verified-resolved'
  return alreadyVerified ? 'verified-resolved' : record.state
}

/** The resolver over one live pipeline. */
export class ErrorResolver {
  private readonly pipeline: ErrorPipeline
  private readonly now: () => Date

  constructor(options: { readonly pipeline: ErrorPipeline; readonly now?: () => Date }) {
    this.pipeline = options.pipeline
    this.now = options.now ?? (() => new Date())
  }

  /**
   * Register one resolution step.
   * @param request - record id, action, note and actor.
   */
  async resolve(request: ResolveRequest): Promise<ResolveOutcome> {
    const record = this.pipeline.record(request.recordId)
    if (record === undefined) {
      return { ok: false, text: `record not found: ${request.recordId}`, subjectKey: null, record: null }
    }
    const at = this.now().toISOString()
    const step = stepOf(STEP_KIND[request.action], at, request.by ?? 'tool', request.note ?? null)
    let next: IssueRecord
    try {
      next = applyStep(record, step)
    } catch (error) {
      if (error instanceof IllegalTransitionError) {
        return { ok: false, text: `rejected: ${error.message} (current state ${record.state}; a record must be analysed before a repair can be registered)`, subjectKey: null, record }
      }
      throw error
    }
    await this.pipeline.save(next)
    const kind = request.action === 'fix-applied' ? null : request.action === 'wontfix' ? null : 'error-record-reopened'
    let subjectKey: string | null = null
    if (kind !== null) {
      subjectKey = await this.pipeline.emit(kind, next, [
        { field: 'state', before: record.state, after: next.state },
        { field: 'reopened', before: false, after: true },
      ])
    }
    const lines = [
      `${request.action} recorded for ${next.recordId}`,
      `state: ${record.state} -> ${next.state}`,
      `count kept: ${String(next.count)}`,
      next.state === 'fix-applied' ? `waiting for ${String(this.pipeline.greenRunsToVerify)} consecutive green runs of ${next.sourceId}/${next.jobId ?? '(unattributed)'} before it turns verified-resolved` : '',
      request.note !== undefined && request.note !== '' ? `note: ${request.note}` : '',
    ].filter((line) => line !== '')
    return { ok: true, text: lines.join('\n'), subjectKey, record: next }
  }
}
