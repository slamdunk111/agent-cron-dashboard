import { describe, expect, it } from 'vitest'
import type { IssueRecord, IssueRecordState } from '../contracts/records.ts'
import { IllegalTransitionError, ISSUE_STATES, LEGAL_TRANSITIONS, applyStep, assertTransition, canTransition, maybeVerify, recordWithAnalysis, stepOf } from '../packages/agent-cron-dashboard/src/fleet/issues-machine.ts'

const BASE: IssueRecord = {
  recordId: 'hermes-nas-0123456789ab',
  signature: '0123456789abcdef0123456789abcdef01234567',
  sourceId: 'hermes-nas',
  jobId: '68f64ca3b0b1',
  state: 'open',
  severity: 'error',
  count: 3,
  firstSeen: '2026-11-05T17:34:31.352+08:00',
  lastSeen: '2026-11-07T16:03:18.272+08:00',
  samples: [{ occurredAt: '2026-11-07T16:03:18.272+08:00', severity: 'error', message: 'measured' }],
  analysis: { state: 'pending', rootCauseHypothesis: null, impact: null, suggestedFix: [], confidence: null, needMoreInfo: [], analyzedAt: null, model: null },
  resolution: [],
  verifiedAt: null,
}

describe('state machine: the whole 36-pair transition table', () => {
  for (const from of ISSUE_STATES) {
    for (const to of ISSUE_STATES) {
      it(`${from} -> ${to}: ${canTransition(from, to) ? 'legal' : 'rejected'}`, () => {
        if (canTransition(from, to)) {
          expect(() => assertTransition(from, to)).not.toThrow()
        } else {
          expect(() => assertTransition(from, to)).toThrow(IllegalTransitionError)
        }
        expect(LEGAL_TRANSITIONS[from].includes(to)).toBe(canTransition(from, to))
      })
    }
  }

  it('has exactly the six contract states', () => {
    expect([...ISSUE_STATES]).toEqual(['open', 'analyzed', 'fix-applied', 'verified-resolved', 'closed-wontfix', 'reopened'])
  })

  it('names both states on rejection', () => {
    try {
      assertTransition('open', 'verified-resolved')
    } catch (error) {
      expect(error).toBeInstanceOf(IllegalTransitionError)
      expect((error as IllegalTransitionError).from).toBe('open')
      expect((error as IllegalTransitionError).to).toBe('verified-resolved')
      expect((error as Error).message).toContain('open -> verified-resolved')
    }
  })

  it('never lets verified-resolved move except back through reopened', () => {
    expect(LEGAL_TRANSITIONS['verified-resolved']).toEqual(['reopened'])
  })
})

describe('applyStep: resolution timeline drives the state', () => {
  it('registers a repair: analyzed -> fix-applied', () => {
    const next = applyStep({ ...BASE, state: 'analyzed' }, stepOf('fix-applied', '2026-11-09T08:00:00+08:00', 'tool', 'patched scripts dir'))
    expect(next.state).toBe('fix-applied')
    expect(next.resolution.at(-1)).toEqual({ kind: 'fix-applied', at: '2026-11-09T08:00:00+08:00', by: 'tool', note: 'patched scripts dir' })
    expect(next.count).toBe(3)
  })

  it('registers a wontfix from open and analyzes it from reopened', () => {
    expect(applyStep(BASE, stepOf('wontfix', '2026-11-09T08:00:00+08:00', 'tool', null)).state).toBe('closed-wontfix')
  })

  it('reopens a verified-resolved record, keeping the count', () => {
    const verified = { ...BASE, state: 'verified-resolved' as const, verifiedAt: '2026-11-08T09:00:00+08:00', count: 7 }
    const next = applyStep(verified, stepOf('reopened', '2026-11-09T09:00:00+08:00', 'scheduler', 'recurrence'))
    expect(next.state).toBe('reopened')
    expect(next.count).toBe(7)
    expect(next.verifiedAt).toBe('2026-11-08T09:00:00+08:00')
  })

  it('rejects a repair on an open record (analysis must come first)', () => {
    expect(() => applyStep(BASE, stepOf('fix-applied', '2026-11-09T08:00:00+08:00', 'tool', null))).toThrow(IllegalTransitionError)
  })

  it('records a green step without moving the state', () => {
    const next = applyStep({ ...BASE, state: 'fix-applied' }, stepOf('green', '2026-11-09T10:00:00+08:00', 'scheduler', 'streak=1'))
    expect(next.state).toBe('fix-applied')
    expect(next.resolution.filter((entry) => entry.kind === 'green')).toHaveLength(1)
  })

  it('rejects a green step on a record that is not waiting for verification', () => {
    expect(() => applyStep(BASE, stepOf('green', '2026-11-09T10:00:00+08:00', 'scheduler', null))).toThrow(IllegalTransitionError)
  })

  it('drops a duplicate final verification step that carries no state change', () => {
    const verified = applyStep({ ...BASE, state: 'fix-applied' }, stepOf('green', '2026-11-09T10:00:00+08:00', 'scheduler', 'streak=3'))
    expect(maybeVerify({ ...verified, state: 'verified-resolved', verifiedAt: '2026-11-09T10:00:00+08:00' }, 3, 3).state).toBe('verified-resolved')
  })
})

describe('maybeVerify: reads the green streak only', () => {
  it('waits one run short of the threshold', () => {
    const before = maybeVerify({ ...BASE, state: 'fix-applied' }, 2, 3)
    expect(before.state).toBe('fix-applied')
    expect(before.verifiedAt).toBeNull()
    expect(before.resolution).toHaveLength(0)
  })

  it('verifies on exactly N with one green step citing the streak', () => {
    const after = maybeVerify({ ...BASE, state: 'fix-applied' }, 3, 3, '2026-11-09T11:00:00+08:00')
    expect(after.state).toBe('verified-resolved')
    expect(after.verifiedAt).toBe('2026-11-09T11:00:00+08:00')
    expect(after.resolution.at(-1)).toEqual({ kind: 'green', at: '2026-11-09T11:00:00+08:00', by: 'scheduler', note: 'streak=3' })
  })

  it('verifies on N+1 as well and emits a single step', () => {
    const after = maybeVerify({ ...BASE, state: 'fix-applied' }, 5, 3, '2026-11-09T11:00:00+08:00')
    expect(after.resolution.filter((entry) => entry.kind === 'green')).toHaveLength(1)
    expect(after.resolution.at(-1)?.note).toBe('streak=5')
  })

  it('never re-verifies a record that already reached verified-resolved', () => {
    const verified = { ...BASE, state: 'verified-resolved' as const, verifiedAt: '2026-11-08T09:00:00+08:00' }
    expect(maybeVerify(verified, 9, 3)).toBe(verified)
  })

  it('leaves every other state untouched (open, analyzed, reopened, wontfix)', () => {
    for (const state of ['open', 'analyzed', 'reopened', 'closed-wontfix'] as IssueRecordState[]) {
      const record = { ...BASE, state }
      expect(maybeVerify(record, 9, 3)).toBe(record)
    }
  })

  it('resolves a threshold below one as invalid', () => {
    expect(() => maybeVerify({ ...BASE, state: 'fix-applied' }, 3, 0)).toThrow(/threshold/)
  })
})

describe('recordWithAnalysis: open -> analyzed carries the analysis payload', () => {
  it('moves to analyzed and stamps analyzedAt/model', () => {
    const next = recordWithAnalysis(BASE, { rootCauseHypothesis: 'vision tower absent', impact: 'daily reports lose images', suggestedFix: ['start the engine with a vision tower'], confidence: 0.8, needMoreInfo: [], model: 'fake-1' }, '2026-11-09T08:00:00+08:00')
    expect(next.state).toBe('analyzed')
    expect(next.analysis.state).toBe('done')
    expect(next.analysis.rootCauseHypothesis).toBe('vision tower absent')
    expect(next.analysis.analyzedAt).toBe('2026-11-09T08:00:00+08:00')
    expect(next.analysis.model).toBe('fake-1')
  })

  it('keeps an already analyzed record analyzed', () => {
    const next = recordWithAnalysis({ ...BASE, state: 'analyzed' }, { rootCauseHypothesis: 'x', impact: 'y', suggestedFix: ['z'], confidence: 0.5, needMoreInfo: [], model: 'fake-1' }, '2026-11-09T08:00:00+08:00')
    expect(next.state).toBe('analyzed')
  })

  it('attaches an analysis to a reopened record (reopened -> analyzed)', () => {
    const next = recordWithAnalysis({ ...BASE, state: 'reopened' }, { rootCauseHypothesis: 'x', impact: 'y', suggestedFix: ['z'], confidence: 0.5, needMoreInfo: [], model: 'fake-1' }, '2026-11-09T08:00:00+08:00')
    expect(next.state).toBe('analyzed')
  })
})
