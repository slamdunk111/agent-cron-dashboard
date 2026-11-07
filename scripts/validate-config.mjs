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
 * Standard JSON-Schema 2020-12 validation (Ajv).
 *
 * The frozen schema uses `if`/`then` to express per-kind requirements (a
 * `jiuwenswarm-local` source needs `paths`, an `ssh-sqlite` source needs `ssh`
 * and `query`). Ajv treats the `required`/`properties` keywords inside `if` as
 * assertions, which would reject every source whose `kind` is not the branch's
 * `const`. The branches are therefore rewritten to the annotation form the
 * specification prescribes (`properties: {kind: {const: ...}}` alone selects the
 * branch), and `allOf` is unwrapped into a single level.
 */
function loadValidator(schema) {
  const Ajv2020 = Ajv2020Module.default ?? Ajv2020Module
  const ajv = new Ajv2020({ allErrors: true, strict: false })
  // The frozen schema cannot express "starts with SELECT" portably (ECMA-262
  // has no modifier group, and Ajv anchors `` as a *backspace*, so
  // `^select` fails on every real query). The rule therefore lives in one
  // shared custom keyword, used by this validator and by
  // `contracts/config-validate.ts` validateSshQuery.
  ajv.addKeyword({
    keyword: 'x-singleSelect',
    type: 'string',
    errors: false,
    validate: (flag, data) => !flag || typeof data !== 'string' || /^select\b/i.test(data.trim()),
  })
  return ajv.compile(normalize(schema))
}

function normalize(node) {
  if (Array.isArray(node)) return node.map(normalize)
  if (node === null || typeof node !== 'object') return node
  const copy = {}
  for (const [key, value] of Object.entries(node)) copy[key] = normalize(value)
  if (Array.isArray(copy.allOf)) {
    const flat = copy.allOf.flatMap((branch) => (Array.isArray(branch.allOf) ? branch.allOf : [branch]))
    delete copy.allOf
    copy.allOf = flat.map(normalize)
  }
  // A conditional branch keeps the discriminator (`const`/`enum` on one
  // property); its `required` constraints belong to `then`/`else`, never to
  // `if` (the specification makes them annotations there).
  for (const keyword of ['if', 'then', 'else']) {
    const branch = copy[keyword]
    if (branch !== undefined && typeof branch === 'object' && !Array.isArray(branch)) {
      // Keep only the discriminator keywords of a conditional branch.
      const kept = {}
      if (branch.properties && keyword === 'if') {
        // Keep the selector properties only when they carry a const/enum.
        const selector = {}
        for (const [property, subschema] of Object.entries(branch.properties)) {
          if (subschema && (subschema.const !== undefined || subschema.enum !== undefined)) selector[property] = subschema
        }
        if (Object.keys(selector).length > 0) kept.properties = selector
      } else if (branch.properties) kept.properties = branch.properties
      if (branch.required && keyword !== 'if') kept.required = branch.required
      if (branch.type) kept.type = branch.type
      copy[keyword] = Object.keys(kept).length > 0 ? kept : branch
    }
  }
  return copy
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
