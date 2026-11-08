import { describe, expect, it } from 'vitest'
import type { ChangeEvent } from '../contracts/events.ts'
import type { ErrorEntry } from '../contracts/fleet-source.ts'
import type { FingerprintRecord, FleetJobRecord, IssueRecord } from '../contracts/records.ts'
import { ErrorPipeline, type PipelineTables } from '../packages/agent-cron-dashboard/src/fleet/error-pipeline.ts'
import { ErrorResolver } from '../packages/agent-cron-dashboard/src/fleet/resolver.ts'
import { recordWithAnalysis } from '../packages/agent-cron-dashboard/src/fleet/issues-machine.ts'
import { DEFAULT_LIMIT, ERRORS_DESCRIPTION, RESOLVE_DESCRIPTION, errorsTool, renderErrors, resolveTool } from '../packages/agent-cron-dashboard/src/fleet/tools-errors.ts'

function memory(): PipelineTables {
  const errors = new Map<string, IssueRecord>()
  const fingerprints = new Map<string, FingerprintRecord>()
  const jobs = new Map<string, FleetJobRecord>()
  const events = new Map<string, ChangeEvent>()
  const table = <T>(store: Map<string, T>) => ({
    get: (key: string) => store.get(key),
    put: async (key: string, value: T) => void store.set(key, value),
    keys: () => [...store.keys()],
    delete: async (key: string) => store.delete(key),
  })
  return { errors: table(errors), fingerprints: table(fingerprints), jobs: table(jobs), events: table(events) }
}

const CLOCK = () => new Date('2026-11-09T09:00:00.000+08:00')

const ANALYSIS = { rootCauseHypothesis: 'the engine was started without a vision tower', impact: 'image analysis fails with 400', suggestedFix: ['restart the engine with HALOGEN_VISION_TOWER', 'route image jobs to a vision worker'], confidence: 0.82, needMoreInfo: ['the engine start command'], model: 'fake-1' }

const ENTRY = (occurredAt: string, message = 'Error analyzing image: Error code: 400', jobId = 'tools.vision_tools'): ErrorEntry => ({ sourceId: 'hermes-nas', jobId, occurredAt, severity: 'error', message, raw: 'fixture' })

async function ledger(): Promise<{ pipeline: ErrorPipeline; resolver: ErrorResolver }> {
  const pipeline = new ErrorPipeline({ tables: memory(), greenRunsToVerify: 3, retentionDays: 90, now: CLOCK })
  await pipeline.ingest([ENTRY('2026-11-07T16:03:18.272+08:00')], { autoAnalyze: false })
  const open = pipeline.records()[0]!
  await pipeline.save(recordWithAnalysis(open, ANALYSIS, '2026-11-09T08:00:00+08:00'))
  await pipeline.ingest([ENTRY('2026-11-08T12:49:37.194+08:00', 'Todo create tool invocation failed', 'cron-todo')], { autoAnalyze: false })
  return { pipeline, resolver: new ErrorResolver({ pipeline, now: CLOCK }) }
}

describe('workbench_errors: the ledger as text', () => {
  it('is read-only and describes itself', async () => {
    const { pipeline } = await ledger()
    const tool = errorsTool(pipeline)
    expect(tool.name).toBe('workbench_errors')
    expect(tool.description).toBe(ERRORS_DESCRIPTION)
    const { text } = await tool.execute({})
    expect(text).toContain('error ledger: 2 record(s), 2 unresolved; showing 2')
  })

  it('shows the analysis, the suggested fix and names an un-analysed row', async () => {
    const { pipeline } = await ledger()
    const { text } = await errorsTool(pipeline).execute({})
    expect(text).toContain('root cause: the engine was started without a vision tower')
    expect(text).toContain('1. restart the engine with HALOGEN_VISION_TOWER')
    expect(text).toContain('2. route image jobs to a vision worker')
    expect(text).toContain('confidence: 0.82 · model fake-1')
    expect(text).toContain('needs more info: the engine start command')
    expect(text).toContain('analysis: not analysed (pending)')
  })

  it('filters by source, state and severity, and by page size', async () => {
    const { pipeline } = await ledger()
    const rows = pipeline.records()
    expect(renderErrors(rows, { source: 'jiuwen-gmk' }).split('\n')[0]).toContain('showing 0')
    expect(renderErrors(rows, { source: 'hermes-nas' }).split('\n')[0]).toContain('showing 2')
    expect(renderErrors(rows, { state: 'open' }).split('\n')[0]).toContain('showing 1')
    expect(renderErrors(rows, { severity: 'warning' })).toContain('(no record matches)')
    expect(renderErrors(rows, { limit: 1 }).split('\n')[0]).toContain('showing 1')
    expect(DEFAULT_LIMIT).toBe(20)
  })

  it('renders the resolution timeline and the verification instant once present', async () => {
    const { pipeline, resolver } = await ledger()
    const analyzed = pipeline.records().find((record) => record.analysis.state === 'done')!
    await resolver.resolve({ recordId: analyzed.recordId, action: 'fix-applied', note: 'restarted with the tower' })
    const { text } = await errorsTool(pipeline).execute({ state: 'fix-applied' })
    expect(text).toContain('resolution: fix-applied@2026-11-09T01:00:00.000Z (restarted with the tower)')
  })

  it('marks a failed analysis instead of pretending it never happened', async () => {
    const { pipeline } = await ledger()
    const row = pipeline.records().find((record) => record.analysis.state === 'pending')!
    await pipeline.save({ ...row, analysis: { ...row.analysis, state: 'failed' } })
    expect((await errorsTool(pipeline).execute({})).text).toContain('analysis: not analysed (model call failed; retry pending)')
  })
})

describe('workbench_resolve: approval-gated write through the tool', () => {
  it('registers a repair and reports success', async () => {
    const { pipeline, resolver } = await ledger()
    const analyzed = pipeline.records().find((record) => record.analysis.state === 'done')!
    const result = await resolveTool(resolver).execute({ recordId: analyzed.recordId, action: 'fix-applied', note: 'set the env' })
    expect(result.ok).toBe(true)
    expect(result.text).toContain('state: analyzed -> fix-applied')
    expect(pipeline.record(analyzed.recordId)!.resolution.at(-1)!.by).toBe('tool')
  })

  it('returns a readable rejection instead of throwing', async () => {
    const { pipeline, resolver } = await ledger()
    const open = pipeline.records().find((record) => record.state === 'open')!
    const result = await resolveTool(resolver).execute({ recordId: open.recordId, action: 'fix-applied' })
    expect(result.ok).toBe(false)
    expect(result.text).toContain('must be analysed before a repair can be registered')
  })

  it('describes itself as an approval-gated write with the three actions', () => {
    const tool = resolveTool(new ErrorResolver({ pipeline: new ErrorPipeline({ tables: memory(), greenRunsToVerify: 3, retentionDays: 90 }) }))
    expect(tool.name).toBe('workbench_resolve')
    expect(tool.description).toBe(RESOLVE_DESCRIPTION)
    expect(tool.description).toContain('approval')
    expect((tool.parameters as { action: { enum: string[] } }).action.enum).toEqual(['fix-applied', 'wontfix', 'reopen'])
  })
})
