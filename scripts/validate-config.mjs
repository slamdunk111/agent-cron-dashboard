#!/usr/bin/env node
/**
 * Replays the config corpus in `fixtures/config-cases.json` against the frozen
 * JSON Schema (`contracts/config.schema.json`, draft 2020-12) and the hand
 * written validator (`contracts/config-validate.ts`), then checks that both
 * implementations agree on every case.
 *
 * Used by `pnpm test` (unit level) and `scripts/smoke-p0.sh` (profile level).
 *
 * Usage: node --experimental-strip-types scripts/validate-config.mjs [--json]
 * Exit code 0 only when every case matches its expected verdict in BOTH engines.
 */
import { readFileSync } from 'node:fs'
import Ajv2020Module from 'ajv/dist/2020.js'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

/**
 * Standard JSON-Schema 2020-12 validation (Ajv), compiled straight from
 * `contracts/config.schema.json` with no rewriting: the per-kind requirements
 * are written as discriminator `if` branches whose `required` sits in
 * `then`/`else`, which Ajv performs correctly as-is (checked against the whole
 * corpus). Any future conditional must keep the same shape — put `required`
 * in `then`, never in `if`.
 */
function loadValidator(schema) {
  const Ajv2020 = Ajv2020Module.default ?? Ajv2020Module
  const ajv = new Ajv2020({ allErrors: true, strict: true })
  return ajv.compile(schema)
}

/**
 * A plain, unextended Ajv instance is the contract's real referee: the schema
 * must be enforceable by a standard 2020-12 validator without registering any
 * custom keyword (a keyword-free schema is what P5's other consumers would get).
 */
function loadPlainValidator(schema) {
  const Ajv2020 = Ajv2020Module.default ?? Ajv2020Module
  return new Ajv2020({ allErrors: true, strict: true }).compile(schema)
}

async function main() {
  const schema = JSON.parse(readFileSync(resolve(root, 'contracts/config.schema.json'), 'utf8'))
  const corpus = JSON.parse(readFileSync(resolve(root, 'fixtures/config-cases.json'), 'utf8'))
  const { validateWorkbenchConfig, ConfigValidationError } = await import(resolve(root, 'contracts/config-validate.ts'))

  const rows = []
  let failures = 0
  const check = loadValidator(schema)
  for (const testCase of corpus.cases) {
    const valid = check(testCase.config)
    const schemaErrors = valid ? [] : [{ path: check.errors?.[0]?.instancePath ?? '$', message: check.errors?.[0]?.message ?? 'invalid' }]
    let tsError = null
    try {
      validateWorkbenchConfig(testCase.config)
    } catch (error) {
      if (!(error instanceof ConfigValidationError)) throw error
      tsError = error.path
    }
    const schemaVerdict = schemaErrors.length === 0 ? 'accept' : 'reject'
    const tsVerdict = tsError === null ? 'accept' : 'reject'
    const agree = schemaVerdict === tsVerdict
    const matchesExpectation = schemaVerdict === testCase.expect
    if (!agree || !matchesExpectation) failures += 1
    rows.push({
      id: testCase.id,
      expect: testCase.expect,
      schema: schemaVerdict,
      typed: tsVerdict,
      agree,
      matchesExpectation,
      schemaError: schemaErrors[0]?.path ?? null,
      typedError: tsError,
    })
  }

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ cases: rows.length, failures, rows }, null, 2))
  } else {
    for (const row of rows) {
      const status = row.agree && row.matchesExpectation ? 'ok  ' : 'FAIL'
      console.log(
        `${status} ${row.id.padEnd(30)} expect=${row.expect.padEnd(6)} schema=${row.schema.padEnd(6)} typed=${row.typed.padEnd(6)} typedError=${row.typedError ?? '-'}`,
      )
    }
    console.log(`${rows.length} cases, ${failures} failure(s)`)
  }
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(2)
})
