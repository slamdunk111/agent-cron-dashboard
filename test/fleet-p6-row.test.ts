import { afterAll, describe, expect, it, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

/** Storage domains are single-open per facility: each test composes its own host. */
const contexts: { storageDomain?: { closeAll(): Promise<void> } }[] = []

afterAll(async () => {
  for (const ctx of contexts) await ctx.storageDomain?.closeAll?.().catch(() => undefined)
})

/** Compose storage exactly the way the P5 row test does. */
async function compose() {
  const { Context } = await import('@deepseek-ai/cordis')
  const { Storage } = await import('@deepseek-ai/dsh-storage')
  const StorageJson = await import('@deepseek-ai/dsh-storage-json')
  const StorageDomain = await import('@deepseek-ai/dsh-storage-domain')
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = mkdtempSync(join(tmpdir(), 'workbench-errors-'))
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  contexts.push(ctx as never)
  return ctx
}

const ROOT = resolve(import.meta.dirname, '..')

/** The eight P5 files that must never name the P6 keys (plan §2.2). */
const P5_FILES = [
  'ssh-exec',
  'log-tail',
  'hermes-ssh',
  'jiuwenswarm-local',
  'generic-ssh-sqlite',
  'grade-fleet',
  'fleet-watch',
].map((name) => resolve(ROOT, `packages/agent-cron-dashboard/src/fleet/${name}.ts`))

describe('P5 source stays clear of the error-record keys', () => {
  it('none of the P5 modules or the P5 smoke names error-record-opened/reopened/verified', () => {
    const files = [...P5_FILES, resolve(ROOT, 'scripts/smoke-p5.mjs')]
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      expect({ file: file.split('/').pop(), hit: /error-record-(opened|reopened|verified)/.test(text) }).toEqual({ file: file.split('/').pop(), hit: false })
    }
  })

  it('only the P6 pipeline and resolver name the three keys', () => {
    const fleetDir = resolve(ROOT, 'packages/agent-cron-dashboard/src/fleet')
    const naming = readdirSync(fleetDir)
      .filter((file) => /error-record-(opened|reopened|verified)/.test(readFileSync(resolve(fleetDir, file), 'utf8')))
      .sort()
    // grade-fleet.ts mentions P6_RESERVED_KINDS as data (the table P5 must not emit); the modules
    // that actually produce the keys are the pipeline (opened/verified/all) and the resolver (reopened).
    expect(naming).toEqual(['error-pipeline.ts', 'resolver.ts'])
    const grade = readFileSync(resolve(fleetDir, 'grade-fleet.ts'), 'utf8')
    // grade-fleet only names the reserved kinds as data; it must not write or emit them.
    expect(grade).not.toMatch(/emit\(|\.put\(|error-record-(opened|reopened|verified)/)
  })
})

describe('P6 mount on the row', () => {
  it('mounts the pipeline over the real domains and stores a path-safe event key', async () => {
    const ctx = await compose()
    const index = await import('../packages/agent-cron-dashboard/src/index.ts')
    const service = index.makeWorkbenchService(ctx, {})
    await vi.waitFor(() => { if (Object.keys(service.domains).length < 8) throw new Error('domains still opening') })
    const { ErrorPipeline } = await import('../packages/agent-cron-dashboard/src/fleet/error-pipeline.ts')
    const { decodeEventKey } = await import('../packages/agent-cron-dashboard/src/fleet/event-key.ts')
    const tables = {
      errors: (service.domains.workbench_fleet_errors as { table(name: string): never }).table('records'),
      fingerprints: (service.domains.workbench_fingerprints as { table(name: string): never }).table('fingerprints'),
      jobs: (service.domains.workbench_fleet_jobs as { table(name: string): never }).table('jobs'),
      events: (service.domains.workbench_events as { table(name: string): never }).table('events'),
    }
    const pipeline = new ErrorPipeline({ tables, greenRunsToVerify: 3, retentionDays: 90 })
    service.errorPipeline = pipeline
    const record = (await pipeline.ingest(
      [{ sourceId: 'hermes-nas', jobId: 'tools.vision_tools', occurredAt: '2026-11-07T16:03:18.272+08:00', severity: 'error', message: 'Error analyzing image: Error code: 400', raw: 'fixture' }],
      { autoAnalyze: false },
    ), pipeline.records()[0]!)
    const errorsDomain = service.domains.workbench_fleet_errors as { table(name: string): { keys(): Iterable<string> } }
    const recordKeys = [...errorsDomain.table('records').keys()]
    expect(recordKeys).toHaveLength(1)
    const eventsDomain = service.domains.workbench_events as { table(name: string): { keys(): Iterable<string> } }
    const keys = [...eventsDomain.table('events').keys()]
    expect(keys).toHaveLength(1)
    const parts = decodeEventKey(keys[0]!)
    expect(parts?.subjectKey).toBe(`error/${record.recordId}`)
    expect(parts?.kind).toBe('error-record-opened')
    expect(record.state).toBe('open')
    expect(record.samples[0]!.message).toBe('Error analyzing image: Error code: 400')
  })

  it('exposes the counters the status tool reads as real ledger numbers', () => {
    const source = readFileSync(resolve(ROOT, 'packages/agent-cron-dashboard/src/index.ts'), 'utf8')
    expect(source).toContain("errors: fleetErrors?.table('records').keys().length ?? 0")
    expect(source).toContain('ctx.effect(() => mountP6(ctx, raw as RowOptions)')
  })

  it('registers workbench_resolve only through the approval seam', () => {
    const source = readFileSync(resolve(ROOT, 'packages/agent-cron-dashboard/src/index.ts'), 'utf8')
    expect(source).toContain("tools.on('tools/pre-execute'")
    expect(source).toContain("if (outcome !== 'allowed-once') return { kind: 'deny'")
    expect(source).toContain('workbench_resolve is not registered (the write path fails closed)')
  })
})
