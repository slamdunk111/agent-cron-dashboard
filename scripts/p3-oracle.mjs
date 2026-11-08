#!/usr/bin/env node
/**
 * Live GitHub issue facts the G1 gate compares against (independent of the
 * poller: its own reads, its own code).
 *
 * Writes one JSON with the machine facts the gate re-derives from the smoke log:
 *   - `searchItems`  : the exact first-search-page item count (`per_page=50`, page 1)
 *   - `totalCount`   : `total_count` of the same answer
 *   - `info`         : an envelope probe: does `GET /repos/o/r/issues` answer an
 *                      `ETag`? (cache headers prove service freshness; `Last-Modified`
 *                      alone is used when the ETag probe fails)
 *
 * Usage: node scripts/p3-oracle.mjs --out ../docs/handoff/p3-oracle-github.json
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'

function GH_BIN() {
  const local = resolve(homedir(), '.local', 'bin', 'gh')
  return existsSync(local) ? local : 'gh'
}

function argOf(argv, name, fallback) {
  const index = argv.indexOf(name)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}

/** One `gh api -i` call: status line + headers + body. */
function ghRich(apiPath, headers = []) {
  const out = execFileSync(GH_BIN(), ['api', '-i', ...headers.flatMap((h) => ['-H', h]), apiPath], { encoding: 'utf8', timeout: 40_000 })
  const split = out.indexOf('\r\n\r\n') >= 0 ? out.indexOf('\r\n\r\n') + 4 : out.indexOf('\n\n') + 2
  const head = out.slice(0, split)
  const body = out.slice(split)
  const lines = head.split(/\r?\n/)
  const status = Number((lines[0] ?? '').split(' ')[1] ?? 0)
  const map = {}
  for (const line of lines.slice(1)) {
    const at = line.indexOf(':')
    if (at > 0) map[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim()
  }
  return { status, headers: map, body }
}

async function main(argv) {
  const at = new Date().toISOString()
  const login = argOf(argv, '--login', 'slamdunk111')
  const search = ghRich(`search/issues?q=${encodeURIComponent(`author:${login} is:issue`)}&per_page=50&page=1`)
  const body = JSON.parse(search.body)
  const items = Array.isArray(body.items) ? body.items.length : 0
  // Envelope probe: the repository issues list exposes cache headers when the
  // token asks for them ("vnd.github+json" default is fine here).
  const probe = ghRich('repos/dptech-corp/Uni-Core/issues?per_page=1')
  const etag = probe.headers.etag ?? null
  const lastModified = probe.headers['last-modified'] ?? null
  const out = {
    at,
    login,
    searchStatus: search.status,
    searchItems: items,
    totalCount: typeof body.total_count === 'number' ? body.total_count : null,
    incompleteResults: body.incomplete_results ?? null,
    searchEtag: search.headers.etag ?? null,
    searchCacheControl: search.headers['cache-control'] ?? null,
    repoListProbe: { path: 'repos/dptech-corp/Uni-Core/issues?per_page=1', status: probe.status, etag, lastModified },
    note:
      'ETag/Last-Modified capture time: when non-null, gate G1 treats an older comment/update as suspicious (a stale cache) until the envelope says otherwise.',
  }
  const path = resolve(argOf(argv, '--out', resolve('../docs/handoff/p3-oracle-github.json')))
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`)
  console.log(`oracle github at=${at} searchItems=${String(items)} totalCount=${String(out.totalCount)} etag=${String(etag)} lastModified=${String(lastModified)}`)
  return 0
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error('oracle failed:', error instanceof Error ? error.message : error)
    process.exit(1)
  })
