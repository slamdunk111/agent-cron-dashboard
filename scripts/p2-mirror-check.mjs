#!/usr/bin/env node
/**
 * Mirror check (G3 #5): the working plan under `.omo/plans/` and its copy in
 * `../docs/handoff/P2-实施计划.md` must have identical bodies (the copy drops
 * the frontmatter). Prints `MIRROR PASS` or the first differing byte offset.
 *
 * Usage: node scripts/p2-mirror-check.mjs [--canonical .omo/plans/p2-pr-seeding.md] [--mirror ../docs/handoff/P2-实施计划.md]
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = argv.indexOf(name)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}

const canonicalPath = resolve(root, argOf('--canonical', '.omo/plans/p2-pr-seeding.md'))
const mirrorPath = resolve(argOf('--mirror', resolve(root, '../docs/handoff/P2-实施计划.md')))
const canonical = readFileSync(canonicalPath, 'utf8')
const body = canonical.split('---\n').slice(2).join('---\n').replace(/^\n/, '')
const mirror = readFileSync(mirrorPath, 'utf8')
const hash = (text) => createHash('sha256').update(text).digest('hex')

if (hash(body) === hash(mirror)) {
  console.log(`MIRROR PASS canonical=${hash(body).slice(0, 16)}`)
  process.exit(0)
}
console.log('MIRROR FAIL: the mirror is not the canonical body')
process.exit(1)
