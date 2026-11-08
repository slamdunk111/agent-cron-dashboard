import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { CHANGE_LEVELS, classifyChange, type ChangeKind } from '../contracts/events.ts'

const root = resolve(import.meta.dirname, '..')

describe('change event grades (design §4.4)', () => {
  it('marks every PR failure/closure signal as high', () => {
    for (const kind of ['pr-ci-failed', 'pr-review-changes-requested', 'pr-conflicting', 'pr-merged', 'pr-closed'] as const) {
      expect(classifyChange(kind)).toBe('high')
    }
  })

  it('keeps review comments, verdicts improving and issue activity at medium', () => {
    for (const kind of ['pr-review-comment', 'pr-draft-ready', 'pr-ci-green', 'issue-closed', 'issue-reopened', 'issue-labeled', 'issue-assigned', 'issue-comment'] as const) {
      expect(classifyChange(kind)).toBe('medium')
    }
  })

  it('grades error records: new/reopened high, verified medium', () => {
    expect(classifyChange('error-record-opened')).toBe('high')
    expect(classifyChange('error-record-reopened')).toBe('high')
    expect(classifyChange('error-record-verified')).toBe('medium')
  })

  it('grades the first-observation kind as digest-only (ADR P2-1)', () => {
    expect(classifyChange('pr-seeded')).toBe('medium')
  })

  it('covers every declared kind exactly once and nothing else', () => {
    const kinds = Object.keys(CHANGE_LEVELS) as ChangeKind[]
    // 20 keys before P2 (13 community + 7 fleet); `pr-seeded` is the one ADR'd
    // addition, so the table now carries 21.
    expect(kinds).toHaveLength(21)
    for (const kind of kinds) expect(['high', 'medium']).toContain(CHANGE_LEVELS[kind])
  })
})

describe('frozen schema documents', () => {
  it('parses contracts/config.schema.json as draft 2020-12', () => {
    const schema = JSON.parse(readFileSync(resolve(root, 'contracts/config.schema.json'), 'utf8'))
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema')
    expect(schema.additionalProperties).toBe(false)
    for (const key of ['identities', 'watch', 'fleet', 'poll', 'analysis', 'notify']) {
      expect(schema.properties).toHaveProperty(key)
    }
  })

  it('keeps the config corpus parseable', () => {
    const corpus = JSON.parse(readFileSync(resolve(root, 'fixtures/config-cases.json'), 'utf8'))
    expect(corpus.cases.length).toBeGreaterThanOrEqual(20)
  })
})
