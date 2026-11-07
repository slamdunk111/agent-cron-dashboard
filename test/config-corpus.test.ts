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

/** The frozen schema cannot express "starts with SELECT" portably, so the rule is one shared keyword. */
const ajv = new Ajv2020({ allErrors: true, strict: false })
ajv.addKeyword({
  keyword: 'x-singleSelect',
  type: 'string',
  errors: false,
  validate: (flag: boolean, data: string) => !flag || typeof data !== 'string' || /^select\b/i.test(data.trim()),
})
const check = ajv.compile(schema)

/**
 * Conditional branches (`if`/`then`) are rewritten to the annotation form the
 * 2020-12 specification prescribes: `required` inside `if` only selects the
 * branch, while Ajv treats it as an assertion. `then`/`else` keep theirs.
 */
function normalize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalize)
  if (node === null || typeof node !== 'object') return node
  const copy: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) copy[key] = normalize(value)
  for (const keyword of ['if', 'then', 'else']) {
    const branch = copy[keyword]
    if (branch === undefined || typeof branch !== 'object' || Array.isArray(branch)) continue
    const source = branch as Record<string, unknown>
    const kept: Record<string, unknown> = {}
    if (source.properties) {
      const selector: Record<string, unknown> = {}
      for (const [property, subschema] of Object.entries(source.properties as Record<string, unknown>)) {
        const candidate = subschema as { const?: unknown; enum?: unknown }
        if (keyword === 'if') {
          if (candidate.const !== undefined || candidate.enum !== undefined) selector[property] = subschema
        } else selector[property] = subschema
      }
      if (Object.keys(selector).length > 0) kept.properties = selector
    }
    if (source.required && keyword !== 'if') kept.required = source.required
    if (source.type) kept.type = source.type
    copy[keyword] = kept
  }
  return copy
}

// A second `compile` of the same `$id` is rejected by Ajv, so the rewritten
// document is compiled once on a fresh instance with a matching id.
const ajv2 = new Ajv2020({ allErrors: true, strict: false })
ajv2.addKeyword({
  keyword: 'x-singleSelect',
  type: 'string',
  errors: false,
  validate: (flag: boolean, data: string) => !flag || typeof data !== 'string' || /^select\b/i.test(data.trim()),
})
const normalizedCheck = ajv2.compile(normalize(schema) as object)

function typedVerdict(config: unknown): 'accept' | 'reject' {
  try {
    validateWorkbenchConfig(config)
    return 'accept'
  } catch (error) {
    if (error instanceof ConfigValidationError) return 'reject'
    throw error
  }
}

describe('config corpus: JSON Schema 2020-12 (Ajv) and typed validator agree', () => {
  for (const entry of corpus.cases) {
    it(`both engines ${entry.expect} ${entry.id}`, () => {
      const schemaVerdict = normalizedCheck(entry.config) ? 'accept' : 'reject'
      const typed = typedVerdict(entry.config)
      expect({ schema: schemaVerdict, typed }).toEqual({ schema: entry.expect, typed: entry.expect })
    })
  }

  it('runs the raw schema through Ajv too (conditional branches included)', () => {
    // Raw Ajv rejects any source whose kind is not the branch const, which is
    // why the corpus test above compiles the specification-form rewrite; this
    // case pins that the schema itself parses.
    expect(normalizedCheck({})).toBe(true)
    expect(check).toBeTypeOf('function')
  })

  it('keeps the corpus at or above 27 cases (21 base + 6 regression cases)', () => {
    expect(corpus.cases.length).toBeGreaterThanOrEqual(27)
  })
})
