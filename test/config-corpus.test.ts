import Ajv2020 from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { validateWorkbenchConfig, ConfigValidationError } from '../contracts/config-validate.ts'

const root = resolve(import.meta.dirname, '..')
const schema = JSON.parse(readFileSync(resolve(root, 'contracts/config.schema.json'), 'utf8'))
const corpus = JSON.parse(readFileSync(resolve(root, 'fixtures/config-cases.json'), 'utf8')) as {
  cases: { id: string; expect: 'accept' | 'reject'; config: unknown }[]
}

/**
 * The schema is compiled exactly as shipped, with a *plain* Ajv 2020-12
 * instance in strict mode and no custom keywords registered: a standard
 * validator must be able to enforce it on its own (P5 and any other consumer
 * get this same bare contract). `contracts/config-validate.ts` is the typed
 * mirror the host runs.
 */
const check = new Ajv2020({ allErrors: true, strict: true }).compile(schema)

function typedVerdict(config: unknown): 'accept' | 'reject' {
  try {
    validateWorkbenchConfig(config)
    return 'accept'
  } catch (error) {
    if (error instanceof ConfigValidationError) return 'reject'
    throw error
  }
}

describe('config corpus: plain JSON Schema 2020-12 (Ajv) and typed validator agree', () => {
  for (const entry of corpus.cases) {
    it(`both engines ${entry.expect} ${entry.id}`, () => {
      const schemaVerdict = check(entry.config) ? 'accept' : 'reject'
      const typed = typedVerdict(entry.config)
      expect({ schema: schemaVerdict, typed }).toEqual({ schema: entry.expect, typed: entry.expect })
    })
  }

  it('keeps the corpus at or above 27 cases (21 base + regression cases)', () => {
    expect(corpus.cases.length).toBeGreaterThanOrEqual(27)
  })

  it('refuses a single DELETE statement at the schema level (no custom keyword needed)', () => {
    const singleDelete = {
      fleet: [{ id: 'a', kind: 'ssh-sqlite', ssh: { host: 'example' }, query: 'DELETE FROM jobs WHERE id > 0' }],
    }
    expect(check(singleDelete)).toBe(false)
    expect(typedVerdict(singleDelete)).toBe('reject')
  })
})
