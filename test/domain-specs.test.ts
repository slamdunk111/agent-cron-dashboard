import { describe, expect, it } from 'vitest'

/**
 * Domain declarations are the storage contract of design §8 (ADR P0-2 maps
 * the dotted keyspace onto valid domain names). These assertions pin the names,
 * versions and table layouts so a rename cannot silently orphan stored data.
 */
describe('storage domain declarations', () => {
  it('declares the eight domains with dsh-valid names', async () => {
    const { DOMAINS } = await import('../packages/agent-cron-dashboard/src/index.ts')
    const names = DOMAINS.map((spec) => spec.name)
    expect(names).toEqual([
      // P4 inserts the graded-event log ahead of the P0 domains (ADR P4-1).
      'workbench_events',
      'workbench_snapshot_pr',
      'workbench_snapshot_issue',
      'workbench_fleet_jobs',
      'workbench_fleet_errors',
      'workbench_fingerprints',
      'workbench_cursors',
      'workbench_fleet_health',
    ])
    for (const name of names) expect(name).toMatch(/^[a-z][a-z0-9_]*$/)
  })

  it('pins version 1 for every domain (bumping needs a migration note)', async () => {
    const { DOMAINS } = await import('../packages/agent-cron-dashboard/src/index.ts')
    for (const spec of DOMAINS) expect(spec.version).toBe(1)
  })

  it('declares one table per domain with the documented key space', async () => {
    const { DOMAINS } = await import('../packages/agent-cron-dashboard/src/index.ts')
    const tables = DOMAINS.map((spec) => Object.keys(spec.tables))
    expect(tables).toEqual([['events'], ['snapshots'], ['snapshots'], ['jobs'], ['records'], ['fingerprints'], ['cursors'], ['health']])
  })
})
