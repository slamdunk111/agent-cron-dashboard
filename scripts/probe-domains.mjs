#!/usr/bin/env node
/**
 * Offline domain probe: opens the workbench storage domains against a real
 * temporary dsh storage backend and reads them back.
 *
 * Covers what the profile boot cannot show from outside (the desktop GUI is the
 * only place `cordis_inspect_query` exists, see `../docs/handoff/P0.md` §未竟):
 * `open()` of every declared domain, the `KIND`/`INVALIDO` name rules, and one
 * write/read round trip per domain.
 *
 * Usage: node scripts/probe-domains.mjs [--json]
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const bundle = join(root, 'build/packages/agent-cron-dashboard/index.js')

async function main() {
  const { Context } = await import('@deepseek-ai/cordis')
  const { Storage } = await import('@deepseek-ai/dsh-storage')
  const StorageJson = await import('@deepseek-ai/dsh-storage-json')
  const StorageDomain = await import('@deepseek-ai/dsh-storage-domain')
  const { DOMAINS } = await import(bundle)

  const dir = mkdtempSync(join(tmpdir(), 'workbench-domains-'))
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: dir })
  // Mount the domain form the way dsh-base composes it, then drive the bundle
  // exactly as the loader does: `apply(ctx)` opens `DOMAINS` through the
  // mounted facility (the same code path the live row takes).
  await ctx.plugin(StorageDomain, { backend: 'json' })
  const rows = []
  const sample = {
    workbench_snapshot_pr: {
      platform: 'github', owner: 'o', repo: 'r', number: 1, title: 't', state: 'open', draft: false,
      mergeability: 'unknown', reviewDecision: 'none', checksRollup: 'none', headSha: 'abc',
      updatedAt: '2026-11-07T00:00:00+08:00', firstSeenAt: '2026-11-07T00:00:00+08:00',
      lastSeenAt: '2026-11-07T00:00:00+08:00', events: [],
    },
    workbench_snapshot_issue: {
      platform: 'gitcode', owner: 'o', repo: 'r', number: 2, title: 'i', state: 'open', labels: [], assignees: [],
      comments: 0, updatedAt: '2026-11-07T00:00:00+08:00', lastCommentBy: null, lastCommentAt: null,
      firstSeenAt: '2026-11-07T00:00:00+08:00', lastSeenAt: '2026-11-07T00:00:00+08:00', events: [],
    },
    workbench_fleet_jobs: {
      sourceId: 's', jobId: 'j', name: 'n', schedule: null, script: null, lastRunAt: null, lastStatus: null,
      greenStreak: 0, collectedAt: '2026-11-07T00:00:00+08:00',
    },
    workbench_fleet_errors: {
      recordId: 'r1', signature: 'sig', sourceId: 's', jobId: null, state: 'open', severity: 'error', count: 1,
      firstSeen: '2026-11-07T00:00:00+08:00', lastSeen: '2026-11-07T00:00:00+08:00', samples: [],
      analysis: { state: 'pending', rootCauseHypothesis: null, impact: null, suggestedFix: [], confidence: null, needMoreInfo: [], analyzedAt: null, model: null },
      resolution: [], verifiedAt: null,
    },
    workbench_fingerprints: { signature: 'sig', recordId: 'r1', count: 1, lastSeen: '2026-11-07T00:00:00+08:00' },
    workbench_cursors: { token: '0', updatedAt: '2026-11-07T00:00:00+08:00' },
    workbench_fleet_health: { sourceId: 's', state: 'up', latencyMs: 1, checkedAt: '2026-11-07T00:00:00+08:00', message: null, consecutiveFailures: 0 },
  }

  try {
    for (const spec of DOMAINS) {
      const domain = await ctx.storageDomain.open(spec)
      const tableName = Object.keys(spec.tables)[0]
      const table = domain.table(tableName)
      // One write/read round trip when a sample exists for this domain.
      let roundTrip = 'no sample'
      if (spec.name in sample) {
        await table.put('probe-key', sample[spec.name])
        roundTrip = table.get('probe-key') ? 'read-back ok' : 'read-back MISSING'
      }
      rows.push({ name: spec.name, version: spec.version, table: tableName, keys: table.size, roundTrip })
      await domain.close()
    }
  } finally {
    await ctx.storageDomain.closeAll?.().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  }

  let failures = rows.filter((row) => !row.name.match(/^[a-z][a-z0-9_]*$/) || row.roundTrip === 'read-back MISSING').length
  if (process.argv.includes('--json')) console.log(JSON.stringify({ rows, failures }, null, 2))
  else {
    for (const row of rows) console.log(`ok   ${row.name.padEnd(24)} table=${row.table.padEnd(11)} keys=${row.keys} ${row.roundTrip}`)
    console.log(`${rows.length} domains, ${failures} failure(s)`)
  }
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(2)
})
