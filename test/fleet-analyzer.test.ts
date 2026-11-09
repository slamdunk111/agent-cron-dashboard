import { describe, expect, it } from 'vitest'
import type { ErrorSample, FleetJobRecord, IssueRecord } from '../contracts/records.ts'
import { AnalysisFormatError, ANALYSIS_OUTPUT_SCHEMA_TEXT, buildPrompt, detailHashOf, detailTextOf, ErrorAnalyzer, levenshtein, parseAnalysis, similarity, type AnalysisChunk, type AnalysisRequest } from '../packages/agent-cron-dashboard/src/fleet/analyzer.ts'

const MEASURED: ErrorSample = {
  occurredAt: '2026-11-07T16:03:18.272+08:00',
  severity: 'error',
  message: 'Error analyzing image: Error code: 400 - {\'error\': {\'message\': \'this server does not accept images: the engine was started without a vision tower (HALOGEN_VISION_TOWER)\'}}',
}

const RECORD: IssueRecord = {
  recordId: 'hermes-nas-0123456789ab',
  signature: '0123456789abcdef0123456789abcdef01234567',
  sourceId: 'hermes-nas',
  jobId: 'tools.vision_tools',
  state: 'open',
  severity: 'error',
  count: 12,
  firstSeen: '2026-11-05T17:34:31.352+08:00',
  lastSeen: '2026-11-08T12:49:37.194+08:00',
  samples: [MEASURED, { ...MEASURED, occurredAt: '2026-11-08T12:49:37.194+08:00' }],
  analysis: { state: 'pending', rootCauseHypothesis: null, impact: null, suggestedFix: [], confidence: null, needMoreInfo: [], analyzedAt: null, model: null },
  resolution: [],
  verifiedAt: null,
}

const JOB: FleetJobRecord = {
  sourceId: 'hermes-nas',
  jobId: 'tools.vision_tools',
  name: 'diag-systemd-health-1h',
  schedule: '20 * * * *',
  script: 'systemd_health_check.py',
  lastRunAt: '2026-11-08T23:20:08.954920+08:00',
  lastStatus: 'ok',
  greenStreak: 0,
  collectedAt: '2026-11-08T23:45:41+08:00',
}

const VALID = { rootCauseHypothesis: 'the inference engine was started without a vision tower', impact: 'image analysis always fails with 400', suggestedFix: ['restart the engine with HALOGEN_VISION_TOWER set', 'route image work to a vision-capable worker'], confidence: 0.82, needMoreInfo: [] }

/** Scripted port: each call consumes the next scripted answer. */
function scriptedPort(scripts: readonly (readonly AnalysisChunk[] | Error | string)[]): { port: { provider: string; model: string; stream(request: AnalysisRequest): AsyncIterable<AnalysisChunk> }; calls: AnalysisRequest[] } {
  const calls: AnalysisRequest[] = []
  let index = 0
  return {
    calls,
    port: {
      provider: 'fake',
      model: 'fake-1',
      async *stream(request: AnalysisRequest) {
        calls.push(request)
        const script = scripts[Math.min(index, scripts.length - 1)]!
        index += 1
        if (script instanceof Error) throw script
        if (typeof script === 'string') {
          yield { type: 'text-delta', text: script }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        for (const chunk of script) yield chunk
      },
    },
  }
}

const ok = (payload: unknown): readonly AnalysisChunk[] => [{ type: 'text-delta', text: JSON.stringify(payload) }, { type: 'finish', reason: { kind: 'stop' } }]

describe('analyzer prompt and schema: one frozen document, no second copy', () => {
  it('states the schema from contracts/config.schema.json $defs.analysisOutput', () => {
    expect(ANALYSIS_OUTPUT_SCHEMA_TEXT).toContain('"rootCauseHypothesis"')
    expect(ANALYSIS_OUTPUT_SCHEMA_TEXT).toContain('"suggestedFix"')
    expect(JSON.parse(ANALYSIS_OUTPUT_SCHEMA_TEXT).properties.confidence.maximum).toBe(1)
  })

  it('carries at most three samples, the job context and the recent runs', () => {
    const prompt = buildPrompt({ ...RECORD, samples: [MEASURED, MEASURED, MEASURED, MEASURED] }, { job: JOB, recentRuns: [{ startedAt: '2026-11-08T23:20:08+08:00', status: 'ok' }, { startedAt: '2026-11-08T22:20:07+08:00', status: 'failed' }] })
    expect(prompt.match(/--- sample /g)).toHaveLength(3)
    expect(prompt).toContain('JOB SCRIPT: systemd_health_check.py')
    expect(prompt).toContain('JOB SCHEDULE: 20 * * * *')
    expect(prompt).toContain('- 2026-11-08T23:20:08+08:00 ok')
    expect(prompt).toContain('- 2026-11-08T22:20:07+08:00 failed')
  })

  it('names the missing context instead of inventing it', () => {
    const prompt = buildPrompt({ ...RECORD, jobId: null, samples: [] }, { job: undefined, recentRuns: [] })
    expect(prompt).toContain('JOB: (unattributed)')
    expect(prompt).toContain('JOB NAME: (unknown)')
    expect(prompt).toContain('(none recorded)')
  })
})

describe('parseAnalysis: the frozen $defs.analysisOutput decides', () => {
  it('accepts a valid payload, fenced or bare', () => {
    expect(parseAnalysis(JSON.stringify(VALID)).confidence).toBe(0.82)
    expect(parseAnalysis('```json\n' + JSON.stringify(VALID) + '\n```').rootCauseHypothesis).toBe(VALID.rootCauseHypothesis)
  })

  it('rejects a confidence above 1', () => {
    expect(() => parseAnalysis(JSON.stringify({ ...VALID, confidence: 1.5 }))).toThrow(AnalysisFormatError)
  })

  it('rejects an empty suggestedFix list', () => {
    expect(() => parseAnalysis(JSON.stringify({ ...VALID, suggestedFix: [] }))).toThrow(AnalysisFormatError)
  })

  it('rejects extra properties (additionalProperties: false)', () => {
    expect(() => parseAnalysis(JSON.stringify({ ...VALID, guess: 'extra' }))).toThrow(AnalysisFormatError)
  })

  it('rejects prose, empty text, and a missing field', () => {
    expect(() => parseAnalysis('I think the tower is missing.')).toThrow(AnalysisFormatError)
    expect(() => parseAnalysis('   ')).toThrow(AnalysisFormatError)
    const { needMoreInfo: _omitted, ...missing } = VALID
    expect(() => parseAnalysis(JSON.stringify(missing))).toThrow(AnalysisFormatError)
  })
})

describe('ErrorAnalyzer.run: success, retry once, then failed', () => {
  it('returns the first valid answer in one call', async () => {
    const { port } = scriptedPort([ok(VALID)])
    const result = await new ErrorAnalyzer({ port }).run(RECORD, { job: JOB, recentRuns: [] })
    expect(result.state).toBe('done')
    expect(result.attempts).toBe(1)
    expect(result.model).toBe('fake-1')
    expect(result.output).toEqual(VALID)
  })

  it('retries once after a format rejection and succeeds', async () => {
    const { port, calls } = scriptedPort([ok({ ...VALID, confidence: 2 }), ok(VALID)])
    const analyzer = new ErrorAnalyzer({ port })
    const result = await analyzer.run(RECORD, { job: JOB, recentRuns: [] })
    expect(result.state).toBe('done')
    expect(result.attempts).toBe(2)
    expect(calls).toHaveLength(2)
    expect(analyzer.calls).toBe(2)
  })

  it('fails after two format rejections with the schema reason recorded', async () => {
    const { port } = scriptedPort([ok({ ...VALID, confidence: 2 }), ok({ ...VALID, suggestedFix: [''] })])
    const result = await new ErrorAnalyzer({ port }).run(RECORD, { job: JOB, recentRuns: [] })
    expect(result.state).toBe('failed')
    expect(result.attempts).toBe(2)
    expect(result.failure).toMatch(/^format: /)
    expect(result.output).toBeNull()
  })

  it('records the provider-neutral failure code of an error finish', async () => {
    const { port } = scriptedPort([[{ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT' } } }], [{ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT' } } }]])
    const result = await new ErrorAnalyzer({ port }).run(RECORD, { job: JOB, recentRuns: [] })
    expect(result.state).toBe('failed')
    expect(result.failure).toBe('error:RATE_LIMIT')
  })

  it('records an aborted finish as aborted', async () => {
    const { port } = scriptedPort([[{ type: 'finish', reason: { kind: 'aborted' } }]])
    const result = await new ErrorAnalyzer({ port }).run(RECORD, { job: JOB, recentRuns: [] })
    expect(result.failure).toBe('aborted')
  })

  it('records a throwing port and a truncated (max-tokens) answer', async () => {
    expect((await new ErrorAnalyzer({ port: scriptedPort([new Error('socket down')]).port }).run(RECORD, { job: JOB, recentRuns: [] })).failure).toMatch(/^throw: socket down/)
    expect((await new ErrorAnalyzer({ port: scriptedPort([[{ type: 'text-delta', text: '{"rootCauseHypothesis":"apl' }, { type: 'finish', reason: { kind: 'max-tokens' } }]]).port }).run(RECORD, { job: JOB, recentRuns: [] })).failure).toBe('finish:max-tokens')
  })

  it('treats an empty stop as a failure', async () => {
    const result = await new ErrorAnalyzer({ port: scriptedPort(['   ']).port }).run(RECORD, { job: JOB, recentRuns: [] })
    expect(result.failure).toBe('empty')
  })
})

describe('ErrorAnalyzer cache: same signature, similar detail', () => {
  it('answers from the cache without a second call', async () => {
    const { port, calls } = scriptedPort([ok(VALID)])
    const analyzer = new ErrorAnalyzer({ port })
    await analyzer.run(RECORD, { job: JOB, recentRuns: [] })
    const second = await analyzer.run(RECORD, { job: JOB, recentRuns: [] })
    expect(second.attempts).toBe(0)
    expect(calls).toHaveLength(1)
    expect(analyzer.cached(RECORD.signature, detailTextOf(RECORD.samples))).toEqual(VALID)
    expect(analyzer.cached(RECORD.signature, 'unrelated text')).toBeUndefined()
  })

  it('re-analyses a variant whose detail drifted past the similarity floor', async () => {
    const { port, calls } = scriptedPort([ok(VALID), ok({ ...VALID, impact: 'now timed out instead of 400' })])
    const analyzer = new ErrorAnalyzer({ port })
    await analyzer.run(RECORD, { job: JOB, recentRuns: [] })
    const drifted: IssueRecord = { ...RECORD, samples: [{ ...MEASURED, message: 'completely unrelated failure on another tool' }] }
    const second = await analyzer.run(drifted, { job: JOB, recentRuns: [] })
    expect(calls).toHaveLength(2)
    expect(second.output?.impact).toBe('now timed out instead of 400')
  })

  it('reuses when the two details are near-identical (one character of 150 differs)', async () => {
    const { port, calls } = scriptedPort([ok(VALID)])
    const analyzer = new ErrorAnalyzer({ port })
    await analyzer.run(RECORD, { job: JOB, recentRuns: [] })
    const nearly: IssueRecord = { ...RECORD, samples: [{ ...MEASURED, message: MEASURED.message.replace('400', '401') }] }
    expect((await analyzer.run(nearly, { job: JOB, recentRuns: [] })).attempts).toBe(0)
    expect(calls).toHaveLength(1)
  })

  it('measures similarity and distance directly', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3)
    expect(levenshtein('', 'abc')).toBe(3)
    expect(levenshtein('abc', '')).toBe(3)
    expect(similarity('same', 'same')).toBe(1)
    expect(similarity('', '')).toBe(1)
    expect(similarity('abcdef', 'abcxef')).toBeGreaterThan(0.8)
  })

  it('hashes distinct details to one key regardless of their instants and repetition', () => {
    const later = { ...MEASURED, occurredAt: '2026-11-08T12:49:37.194+08:00' }
    expect(detailHashOf([MEASURED, later])).toBe(detailHashOf([MEASURED]))
    expect(detailHashOf([MEASURED])).not.toBe(detailHashOf([{ ...MEASURED, message: 'other' }]))
  })

describe('analyser port label', () => {
  it('names provider and model together for the tool face and the snapshot', () => {
    const analyser = new ErrorAnalyzer({ port: scriptedPort([]).port })
    expect(analyser.label).toBe('fake/fake-1')
  })
})
})
