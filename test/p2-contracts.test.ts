import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { capabilities } from '../packages/dsh-forge-gitcode/src/index.ts'
import { GITCODE_CAPABILITIES, GITCODE_UNSUPPORTED } from '../contracts/gitcode-capabilities.ts'
import { CHANGE_LEVELS, type SnapshotPair } from '../contracts/events.ts'

const root = resolve(import.meta.dirname, '..')

describe('ADR P2-2: capability contract constant', () => {
  it('carries exactly the 13 capabilities the diff table lists', () => {
    expect(GITCODE_CAPABILITIES).toHaveLength(13)
    const names = GITCODE_CAPABILITIES.map((entry) => entry.capability)
    expect(new Set(names).size).toBe(13)
  })

  it('declares the four measured gaps as unsupported', () => {
    expect([...GITCODE_UNSUPPORTED].sort()).toEqual(['fetchChecks', 'markReady', 'merge', 'submitReview'])
  })

  it('matches the provider implementation verbatim (no drift)', () => {
    const provider = capabilities()
    expect(provider).toHaveLength(GITCODE_CAPABILITIES.length)
    for (const [index, entry] of GITCODE_CAPABILITIES.entries()) {
      expect(provider[index]).toEqual(entry)
    }
  })
})

describe('ADR P2-1: first-observation kind and snapshot pair', () => {
  it('adds exactly one kind, graded medium (P3 later adds `issue-seeded`, ADR P3-1)', () => {
    expect(CHANGE_LEVELS['pr-seeded']).toBe('medium')
    // 22 = 20 before P2 + `pr-seeded` (P2-1) + `issue-seeded` (P3-1).
    expect(Object.keys(CHANGE_LEVELS)).toHaveLength(22)
  })

  it('SnapshotPair keeps before nullable for the first observation', () => {
    const pair: SnapshotPair<{ state: string }> = {
      key: 'gitcode/openJiuwen/jiuwenswarm/9722',
      before: null,
      after: { state: 'open' },
      at: '2026-11-08T13:05:37+08:00',
    }
    expect(pair.before).toBeNull()
    expect(pair.after.state).toBe('open')
  })
})

describe('P2 fixtures (captured 2026-11-08, tokens redacted)', () => {
  it('keeps the GitCode authored-request page and the single request', () => {
    const page = JSON.parse(readFileSync(resolve(root, 'fixtures/gitcode/pulls-mine-all-p1.json'), 'utf8'))
    expect(Array.isArray(page)).toBe(true)
    const mine = page[0].items.filter((entry: { user: { login: string } }) => entry.user.login === 'nawenyu139')
    expect(mine.map((entry: { number: number }) => entry.number).sort()).toEqual([9691, 9693, 9695, 9702, 9704, 9705, 9706, 9707, 9722])
    const one = JSON.parse(readFileSync(resolve(root, 'fixtures/gitcode/pull-9722.json'), 'utf8'))
    expect(one.number).toBe(9722)
    expect(one.state).toBe('open')
    expect(one._capturedAt).toMatch(/^2026-11-08T/)
  })

  it('keeps the GitHub request (including the empty status case)', () => {
    const pull = JSON.parse(readFileSync(resolve(root, 'fixtures/github/pull-75.json'), 'utf8'))
    expect(pull.number).toBe(75)
    expect(pull.user.login).toBe('slamdunk111')
    const status = JSON.parse(readFileSync(resolve(root, 'fixtures/github/status-uni-core-75.json'), 'utf8'))
    expect(status.state).toBe('pending')
    expect(status.total_count).toBe(0)
    expect(status.check_total_count).toBe(0)
  })

  it('keeps the non-empty CI sample from a repository that runs actions', () => {
    const status = JSON.parse(readFileSync(resolve(root, 'fixtures/github/status-vllm-14240.json'), 'utf8'))
    expect(status.state).toBe('success')
    expect(status.check_total_count).toBe(12)
    expect(status.check_conclusions).toContain('failure')
  })
})
