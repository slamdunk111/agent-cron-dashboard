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
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

/**
 * Does `instance` satisfy `schema` used as an `if` condition?
 *
 * The 2020-12 specification makes `required` and `properties` annotations
 * when they appear outside assertion-bearing keywords: inside an `if` they
 * only select `then`/`else`. This evaluator therefore checks only the
 * assertion keywords the frozen schema uses, and steps through `allOf`.
 */
function matchesCondition(instance, schema, rootSchema) {
  if (schema === true) return true
  if (schema === false) return false
  if (schema.enum && !schema.enum.includes(instance)) return false
  if (schema.const !== undefined && instance !== schema.const) return false
  const inner = schema.properties
  if (inner) {
    if (typeof instance !== 'object' || instance === null) return false
    for (const [key, subschema] of Object.entries(inner)) {
      if (key in instance && !matchesCondition(instance[key], subschema, rootSchema)) return false
    }
  }
  if (schema.allOf) return schema.allOf.every((branch) => matchesCondition(instance, branch, rootSchema))
  if (schema.anyOf) return schema.anyOf.some((branch) => matchesCondition(instance, branch, rootSchema))
  if (schema.type) {
    const ok =
      schema.type === 'object'
        ? typeof instance === 'object' && instance !== null && !Array.isArray(instance)
        : schema.type === 'string'
          ? typeof instance === 'string'
          : true
    if (!ok) return false
  }
  return true
}

/** Minimal JSON-Schema (2020-12) evaluator limited to the keywords the frozen schema uses. */
function validate(instance, schema, rootSchema, path = '$') {
  if (schema === true) return []
  if (schema === false) return [{ path, message: 'schema is false' }]
  const errors = []
  if (schema.$ref) {
    const ref = schema.$ref
    if (!ref.startsWith('#/')) throw new Error(`unsupported $ref ${ref}`)
    const target = ref
      .slice(2)
      .split('/')
      .reduce((node, key) => node[decodeURIComponent(key.replace(/~1/g, '/').replace(/~0/g, '~'))], rootSchema)
    return validate(instance, target, rootSchema, path)
  }
  const typeOk = () => {
    switch (schema.type) {
      case undefined:
        return true
      case 'object':
        return typeof instance === 'object' && instance !== null && !Array.isArray(instance)
      case 'array':
        return Array.isArray(instance)
      case 'string':
        return typeof instance === 'string'
      case 'integer':
        return typeof instance === 'number' && Number.isInteger(instance)
      case 'number':
        return typeof instance === 'number'
      case 'boolean':
        return typeof instance === 'boolean'
      default:
        throw new Error(`unsupported type ${schema.type}`)
    }
  }
  if (!typeOk()) {
    errors.push({ path, message: `expected ${schema.type}` })
    return errors
  }
  if (schema.enum && !schema.enum.includes(instance)) errors.push({ path, message: `expected one of ${schema.enum.join('|')}` })
  if (typeof instance === 'string') {
    if (schema.minLength !== undefined && instance.length < schema.minLength) errors.push({ path, message: 'too short' })
    if (schema.maxLength !== undefined && instance.length > schema.maxLength) errors.push({ path, message: 'too long' })
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(instance)) {
      errors.push({ path, message: `does not match ${schema.pattern}` })
    }
  }
  if (typeof instance === 'number') {
    if (schema.minimum !== undefined && instance < schema.minimum) errors.push({ path, message: `below ${schema.minimum}` })
    if (schema.maximum !== undefined && instance > schema.maximum) errors.push({ path, message: `above ${schema.maximum}` })
  }
  if (Array.isArray(instance)) {
    if (schema.maxItems !== undefined && instance.length > schema.maxItems) errors.push({ path, message: 'too many items' })
    if (schema.minItems !== undefined && instance.length < schema.minItems) errors.push({ path, message: 'too few items' })
    if (schema.items) instance.forEach((item, index) => errors.push(...validate(item, schema.items, rootSchema, `${path}[${index}]`)))
  }
  // `required` inside `if`/`then`/`else` selects a branch only; those keywords are visited below.
  if (typeof instance === 'object' && instance !== null && !Array.isArray(instance) && !schema.inConditional) {
    if (schema.required) {
      for (const key of schema.required) if (!(key in instance)) errors.push({ path: `${path}.${key}`, message: 'required' })
    }
    if (schema.properties) {
      for (const [key, value] of Object.entries(instance)) {
        if (key in schema.properties) errors.push(...validate(value, schema.properties[key], rootSchema, `${path}.${key}`))
        else if (schema.additionalProperties === false) errors.push({ path: `${path}.${key}`, message: 'unknown property' })
      }
    } else if (schema.additionalProperties === false) {
      for (const key of Object.keys(instance)) errors.push({ path: `${path}.${key}`, message: 'unknown property' })
    }
  }
  if (schema.not) {
    const inner = validate(instance, schema.not, rootSchema, path)
    if (inner.length === 0) errors.push({ path, message: 'matches the forbidden pattern' })
  }
  if (schema.allOf) for (const branch of schema.allOf) errors.push(...validate(instance, branch, rootSchema, path))
  if (schema.anyOf) {
    const branches = schema.anyOf.map((branch) => validate(instance, branch, rootSchema, path))
    if (!branches.some((branch) => branch.length === 0)) errors.push({ path, message: 'matches no anyOf branch' })
  }
  if (schema.oneOf) {
    const branches = schema.oneOf.map((branch) => validate(instance, branch, rootSchema, path))
    if (branches.filter((branch) => branch.length === 0).length !== 1) {
      errors.push({ path, message: 'must match exactly one oneOf branch' })
    }
  }
  if (schema.if) {
    // Annotation-only keywords (`required`, `properties`) select the `then`
    // subschema instead of rejecting the instance (§10.2.2.1), so they are
    // visited on `then`/`else` paths rather than while evaluating `if`.
    const condition = matchesCondition(instance, schema.if, rootSchema)
    if (condition && schema.then) errors.push(...validate(instance, schema.then, rootSchema, path))
    if (!condition && schema.else) errors.push(...validate(instance, schema.else, rootSchema, path))
  }
  return errors
}

async function main() {
  const schema = JSON.parse(readFileSync(resolve(root, 'contracts/config.schema.json'), 'utf8'))
  const corpus = JSON.parse(readFileSync(resolve(root, 'fixtures/config-cases.json'), 'utf8'))
  const { validateWorkbenchConfig, ConfigValidationError } = await import(resolve(root, 'contracts/config-validate.ts'))

  const rows = []
  let failures = 0
  for (const testCase of corpus.cases) {
    const schemaErrors = validate(testCase.config, schema, schema)
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
