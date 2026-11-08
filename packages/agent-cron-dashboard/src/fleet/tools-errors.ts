/**
 * Error tool face (P6 task 5, design §6): `workbench_errors` (read-only ledger
 * query) and `workbench_resolve` (the approval-gated write).
 *
 * Both render plain text for the conversation; every line is masked and the
 * un-analysed state is named instead of hidden ("未分析" is what the owner asked
 * to see when the model has not answered yet).
 */
import type { ErrorSample, IssueRecord, IssueRecordState } from '../../../../contracts/records.ts'
import type { ErrorPipeline } from './error-pipeline.ts'
import type { ErrorResolver, ResolveAction } from './resolver.ts'
import { RESOLVE_ACTIONS } from './resolver.ts'

/** Name of the read-only ledger tool. */
export const ERRORS_TOOL = 'workbench_errors'
/** Name of the approval-gated write tool. */
export const RESOLVE_TOOL = 'workbench_resolve'

/** Description shown for {@link ERRORS_TOOL}. */
export const ERRORS_DESCRIPTION = 'List the fleet error ledger (filter by source, state or severity) with analysis, suggested fixes and the resolution timeline. Read-only.'
/** Description shown for {@link RESOLVE_TOOL}. */
export const RESOLVE_DESCRIPTION = 'Register a repair (fix-applied), a wontfix decision, or a reopen for one error record. Write operation, requires approval.'

/**
 * Query accepted by {@link renderErrors}. The tool schema declares exactly
 * `source`, `state`, `severity` and `limit`; a caller that passes more keys
 * simply gets every row back for the ones it did not set.
 */
export interface ErrorsQuery {
  readonly source?: string
  readonly state?: IssueRecordState
  readonly severity?: string
  readonly limit?: number
}

/** Default page size of the ledger view. */
export const DEFAULT_LIMIT = 20

/** States, in the order the tool prints them. */
const STATE_ORDER: readonly IssueRecordState[] = ['open', 'reopened', 'analyzed', 'fix-applied', 'verified-resolved', 'closed-wontfix']

/** One sample line, cut for display. */
function sampleLine(sample: ErrorSample): string {
  return `    - ${sample.occurredAt} ${sample.severity}: ${sample.message.slice(0, 200)}`
}

/** Render one record block. */
function recordBlock(record: IssueRecord, index: number): string[] {
  const lines: string[] = [
    `[${String(index)}] ${record.state.toUpperCase()} ${record.recordId}`,
    `  fingerprint ${record.signature.slice(0, 12)} · source ${record.sourceId} · job ${record.jobId ?? '(unattributed)'} · severity ${record.severity}`,
    `  occurrences ${String(record.count)} (first ${record.firstSeen}, last ${record.lastSeen})`,
  ]
  if (record.analysis.state === 'done') {
    lines.push(`  root cause: ${record.analysis.rootCauseHypothesis ?? '-'}`)
    lines.push(`  impact: ${record.analysis.impact ?? '-'}`)
    lines.push(`  confidence: ${record.analysis.confidence === null ? '-' : record.analysis.confidence.toFixed(2)} · model ${record.analysis.model ?? '-'}`)
    lines.push('  suggested fix:')
    for (const step of record.analysis.suggestedFix) lines.push(`    ${String(record.analysis.suggestedFix.indexOf(step) + 1)}. ${step}`)
    if (record.analysis.needMoreInfo.length > 0) lines.push(`  needs more info: ${record.analysis.needMoreInfo.join('; ')}`)
  } else {
    lines.push(`  analysis: ${record.analysis.state === 'failed' ? 'not analysed (model call failed; retry pending)' : 'not analysed (pending)'}`)
  }
  lines.push(`  resolution: ${record.resolution.length === 0 ? '(none yet)' : record.resolution.map((step) => `${step.kind}@${step.at}${step.note === null ? '' : ` (${step.note})`}`).join(' -> ')}`)
  if (record.verifiedAt !== null) lines.push(`  verified at: ${record.verifiedAt}`)
  if (record.samples.length > 0) {
    lines.push(`  samples (${String(record.samples.length)}):`)
    for (const sample of record.samples) lines.push(sampleLine(sample))
  }
  return lines
}

/**
 * Render the ledger view.
 * @param records - ledger rows (already masked on write).
 * @param query - filters and page size.
 */
export function renderErrors(records: readonly IssueRecord[], query: ErrorsQuery = {}): string {
  const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), 100)
  const filtered = records
    .filter((record) => query.source === undefined || record.sourceId === query.source)
    .filter((record) => query.state === undefined || record.state === query.state)
    .filter((record) => query.severity === undefined || record.severity === query.severity)
    .sort((left, right) => STATE_ORDER.indexOf(left.state) - STATE_ORDER.indexOf(right.state) || right.lastSeen.localeCompare(left.lastSeen))
  const unresolved = records.filter((record) => record.state !== 'verified-resolved' && record.state !== 'closed-wontfix').length
  const header = `error ledger: ${String(records.length)} record(s), ${String(unresolved)} unresolved; showing ${String(Math.min(filtered.length, limit))}`
  if (filtered.length === 0) return `${header}\n(no record matches)`
  const blocks: string[] = []
  for (const [index, record] of filtered.slice(0, limit).entries()) blocks.push(...recordBlock(record, index + 1))
  return [header, ...blocks].join('\n')
}

/**
 * Build the read side of {@link ERRORS_TOOL}.
 * @param pipeline - the live ledger.
 */
export function errorsTool(pipeline: ErrorPipeline): { name: string; description: string; parameters: Record<string, unknown>; execute: (args: ErrorsQuery) => Promise<{ text: string }> } {
  return {
    name: ERRORS_TOOL,
    description: ERRORS_DESCRIPTION,
    parameters: {
      source: { type: 'string', description: 'Fleet source id (e.g. hermes-nas).' },
      state: { type: 'string', enum: [...STATE_ORDER], description: 'Lifecycle state filter.' },
      severity: { type: 'string', enum: ['info', 'warning', 'error', 'critical'], description: 'Severity filter.' },
      limit: { type: 'number', description: `Maximum records (default ${String(DEFAULT_LIMIT)}).` },
    },
    execute: async (args: ErrorsQuery) => ({ text: renderErrors(pipeline.records(), args ?? {}) }),
  }
}

/**
 * Build the write side of {@link RESOLVE_TOOL}; the host registers it through
 * the approval channel, so the resolver itself never auto-applies anything.
 * @param resolver - the pipeline-backed resolver.
 */
export function resolveTool(resolver: ErrorResolver): { name: string; description: string; parameters: Record<string, unknown>; execute: (args: { recordId: string; action: ResolveAction; note?: string }) => Promise<{ text: string; ok: boolean }> } {
  return {
    name: RESOLVE_TOOL,
    description: RESOLVE_DESCRIPTION,
    parameters: {
      recordId: { type: 'string', description: 'Ledger record id (see workbench_errors).' },
      action: { type: 'string', enum: [...RESOLVE_ACTIONS], description: 'fix-applied registers the repair; wontfix dismisses; reopen hands it back for analysis.' },
      note: { type: 'string', description: 'What was done (shown in the resolution timeline).' },
    },
    execute: async (args: { recordId: string; action: ResolveAction; note?: string }) => {
      const outcome = await resolver.resolve({ ...args, by: 'tool' })
      return { text: outcome.text, ok: outcome.ok }
    },
  }
}
