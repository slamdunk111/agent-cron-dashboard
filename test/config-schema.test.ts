import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  ConfigValidationError,
  validateWorkbenchConfig,
  validateTokenEnv,
} from '../contracts/config-validate.ts'

const root = resolve(import.meta.dirname, '..')
const corpus = JSON.parse(readFileSync(resolve(root, 'fixtures/config-cases.json'), 'utf8')) as {
  cases: { id: string; expect: 'accept' | 'reject'; config: unknown }[]
}

/** Replay one corpus case against the typed validator. */
function verdict(config: unknown): { ok: true } | { ok: false; path: string } {
  try {
    validateWorkbenchConfig(config)
    return { ok: true }
  } catch (error) {
    if (error instanceof ConfigValidationError) return { ok: false, path: error.path }
    throw error
  }
}

describe('typed validator (mirror of contracts/config.schema.json; the JSON Schema engine runs in config-corpus.test.ts)', () => {
  it('contains the design §7 sample as an accepted case', () => {
    expect(corpus.cases.some((entry) => entry.id === 'design-section-7-sample' && entry.expect === 'accept')).toBe(true)
  })

  for (const entry of corpus.cases) {
    it(`${entry.expect}s ${entry.id}`, () => {
      const result = verdict(entry.config)
      expect(result.ok).toBe(entry.expect === 'accept')
    })
  }

  it('rejects a token literal with a stable error class and path', () => {
    let raised: unknown
    try {
      validateWorkbenchConfig({ identities: [{ platform: 'gitcode', username: 'nawenyu', token: 'glpat-abcdefghijklmnop' }] })
    } catch (error) {
      raised = error
    }
    expect(raised).toBeInstanceOf(ConfigValidationError)
    expect((raised as ConfigValidationError).path).toBe('$.identities[0].token')
  })

  it('accepts an environment variable NAME but not a credential-shaped value', () => {
    expect(validateTokenEnv('$.tokenEnv', 'GITCODE_TOKEN')).toBe('GITCODE_TOKEN')
    expect(() => validateTokenEnv('$.tokenEnv', 'ghp_0123456789abcdefghij')).toThrow(ConfigValidationError)
    expect(() => validateTokenEnv('$.tokenEnv', 'glpat-abcdefghijklmnop')).toThrow(ConfigValidationError)
  })

  it('applies the documented defaults', () => {
    const resolved = validateWorkbenchConfig({})
    expect(resolved.watch.issuePollIntervalMs).toBe(300000)
    expect(resolved.poll.fleetIntervalMs).toBe(300000)
    expect(resolved.poll.backoffMaxMs).toBe(3600000)
    expect(resolved.analysis.greenRunsToVerify).toBe(3)
    expect(resolved.analysis.retentionDays).toBe(90)
    expect(resolved.notify.actionCards).toBe(true)
    expect(resolved.notify.digest.cron).toBe('0 9 * * *')
  })

  it('tolerates a trailing semicolon in a read-only query but not a second statement', () => {
    const base = { id: 'any-ssh', kind: 'ssh-sqlite' as const, ssh: { host: 'example' }, query: 'SELECT id FROM t;' }
    expect(validateWorkbenchConfig({ fleet: [base] }).fleet[0]?.query).toBe('SELECT id FROM t')
    expect(() => validateWorkbenchConfig({ fleet: [{ ...base, query: 'SELECT id FROM t; DROP TABLE t' }] })).toThrow(ConfigValidationError)
  })

  // P5 (ADR P5-1): the generic adapter reads its three optional queries through
  // the same single-SELECT rule as `query`.
  it('accepts the three optional adapter queries and normalises them', () => {
    const base = {
      id: 'any-ssh',
      kind: 'ssh-sqlite' as const,
      ssh: { host: 'example', dbPath: '/srv/app.db' },
      query: 'SELECT id FROM t',
      runsQuery: 'SELECT id, job_id, started_at, status FROM runs',
      jobsQuery: 'SELECT job_id, name, schedule FROM jobs',
      errorsQuery: 'SELECT occurred_at, severity, message FROM errors;',
    }
    const resolved = validateWorkbenchConfig({ fleet: [base] }).fleet[0]
    expect(resolved?.runsQuery).toBe('SELECT id, job_id, started_at, status FROM runs')
    expect(resolved?.jobsQuery).toBe('SELECT job_id, name, schedule FROM jobs')
    expect(resolved?.errorsQuery).toBe('SELECT occurred_at, severity, message FROM errors')
  })

  it('rejects a second statement inside any optional adapter query', () => {
    for (const key of ['runsQuery', 'jobsQuery', 'errorsQuery'] as const) {
      const candidate = { id: 'any-ssh', kind: 'ssh-sqlite' as const, ssh: { host: 'example' }, query: 'SELECT id FROM t', [key]: 'SELECT id FROM t; DELETE FROM t' }
      expect(() => validateWorkbenchConfig({ fleet: [candidate] })).toThrow(ConfigValidationError)
    }
  })
})
