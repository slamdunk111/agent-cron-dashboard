import { afterAll, describe, expect, it, vi } from 'vitest'

/** Storage domains are single-open per facility: each test composes its own host. */
const contexts: { storageDomain?: { closeAll(): Promise<void> } }[] = []

afterAll(async () => {
  for (const ctx of contexts) await ctx.storageDomain?.closeAll?.().catch(() => undefined)
})

/** Compose storage exactly the way dsh-base does (storage hub + json backend + domain form). */
async function compose() {
  const { Context } = await import('@deepseek-ai/cordis')
  const { Storage } = await import('@deepseek-ai/dsh-storage')
  const StorageJson = await import('@deepseek-ai/dsh-storage-json')
  const StorageDomain = await import('@deepseek-ai/dsh-storage-domain')
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = mkdtempSync(join(tmpdir(), 'workbench-fleet-'))
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  contexts.push(ctx as never)
  return ctx
}

describe('fleet mount on the row (P5)', () => {
  it('mounts the fleet watch with an injected adapter and persists jobs/health', async () => {
    const ctx = await compose()
    const { makeWorkbenchService } = await import('../packages/agent-cron-dashboard/src/index.ts')
    const service = makeWorkbenchService(ctx, {})
    await vi.waitFor(() => { if (Object.keys(service.domains).length < 8) throw new Error('domains still opening') })
    const fakeSource = {
      id: 'fixture-hermes',
      kind: 'hermes-ssh' as const,
      listJobs: async () => [{ id: '68f64ca3b0b1', name: 'patrol', schedule: '20 * * * *', script: 'patrol.py', lastRunAt: null, lastStatus: null }],
      fetchRuns: async () => ({ runs: [], cursor: { token: '0' } }),
      fetchErrorEntries: async () => ({ entries: [], cursor: { token: '0' } }),
      health: async () => ({ sourceId: 'fixture-hermes', state: 'up' as const, latencyMs: 1, checkedAt: '2026-11-08T00:00:00.000Z', message: null, consecutiveFailures: 0 }),
    }
    const { FleetWatchService } = await import('../packages/agent-cron-dashboard/src/fleet/fleet-watch.ts')
    const jobs = service.domains.workbench_fleet_jobs as { table(name: string): { keys(): readonly string[]; get(key: string): unknown } }
    const jobsTable = jobs.table('jobs')
    const watch = new FleetWatchService({
      sources: [fakeSource],
      tables: {
        jobs: jobs.table('jobs') as never,
        cursors: (service.domains.workbench_cursors as { table(name: string): never }).table('cursors'),
        health: (service.domains.workbench_fleet_health as { table(name: string): never }).table('health'),
        events: (service.domains.workbench_events as { table(name: string): never }).table('events'),
      },
      autoStart: false,
    })
    service.fleetWatch = watch
    service.fleetSources = [fakeSource]
    await watch.runOnce()
    // the source's job list was persisted into the fleet jobs domain under `<sourceId>/<jobId>`
    expect([...jobsTable.keys()]).toContain('fixture-hermes/68f64ca3b0b1')
    expect((service.domains.workbench_fleet_health as { table(name: string): { get(key: string): { state: string } | undefined } }).table('health').get('fixture-hermes')?.state).toBe('up')
    const { buildStatus } = await import('../packages/agent-cron-dashboard/src/core/tools-status.ts')
    const events = (service.domains.workbench_events as { table(name: string): { keys(): readonly string[]; get(key: string): never } }).table('events')
    const report = buildStatus(
      { events, prCount: () => 0, issueCount: () => 0, fleet: { jobs: 1, errors: 0, sourcesUp: 1, sourcesTotal: 1 } },
      'fleet',
    )
    expect(report.text).toContain('fleet: 1 job(s)')
    expect(report.text).toContain('fleet health: 1/1 source(s) up')
    expect(report.stats.fleetJobs).toBe(1)
    watch.stop()
  })

  it('reports the old placeholder line when the fleet surface is absent', async () => {
    const { buildStatus } = await import('../packages/agent-cron-dashboard/src/core/tools-status.ts')
    const report = buildStatus({ events: { keys: () => [], get: () => undefined }, prCount: () => 0, issueCount: () => 0, fleet: null }, 'all')
    expect(report.text).toContain('fleet: not wired yet')
    expect(report.stats.fleetJobs).toBeNull()
  })
})
