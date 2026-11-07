import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

// Storage domains are single-open per facility: each test composes its own host
// and opens the domains itself; `afterAll` releases the leftovers.

/**
 * Row-path proof: compose the host exactly as dsh-base does (storage hub, json
 * backend, domain form) and mount the bundle's own `apply`, then assert that
 * the row opened all seven storage domains. This is the evidence the
 * acceptance gate needs and that the file-system probe could not provide: the
 * json backend only materialises a unit on the first write.
 */
const roots: string[] = []
const contexts: { storageDomain?: { closeAll(): Promise<void> } }[] = []

afterAll(async () => {
  for (const ctx of contexts) await ctx.storageDomain?.closeAll?.().catch(() => {})
})

async function compose() {
  const { Context } = await import('@deepseek-ai/cordis')
  const { Storage } = await import('@deepseek-ai/dsh-storage')
  const StorageJson = await import('@deepseek-ai/dsh-storage-json')
  const StorageDomain = await import('@deepseek-ai/dsh-storage-domain')
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = mkdtempSync(join(tmpdir(), 'workbench-row-'))
  roots.push(root)
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  contexts.push(ctx as never)
  return ctx
}

afterEach(() => {
  vi.useRealTimers()
})

describe('row apply opens the storage domains', () => {
  it('opens seven domains and reports no domainError', async () => {
    const ctx = await compose()
    const { makeWorkbenchService, getWorkbenchService, DOMAINS } = await import('../packages/agent-cron-dashboard/src/index.ts')
    const service = makeWorkbenchService(ctx, {})
    expect(service).toBeInstanceOf(Object)
    // Mounting is asynchronous: wait for the domains the row opens itself.
    await vi.waitFor(() => expect(Object.keys(service.domains)).toHaveLength(7))
    expect(service.domainError).toBeNull()
    expect(Object.keys(service.domains).sort()).toEqual([...DOMAINS.map((spec) => spec.name)].sort())
    expect(getWorkbenchService()).toBe(service)
    // Usability, not just presence: a domain closed right after opening would
    // still count as a key, so write and read one record back through it.
    const fingerprints = service.domains.workbench_fingerprints as {
      table(name: string): { put(key: string, value: unknown): Promise<void>; get(key: string): unknown }
    }
    const record = { signature: 'sig-row', recordId: 'rec-row', count: 1, lastSeen: '2026-11-07T00:00:00+08:00' }
    await fingerprints.table('fingerprints').put('sig-row', record)
    expect(fingerprints.table('fingerprints').get('sig-row')).toMatchObject({ recordId: 'rec-row' })
  })

  it('keeps every domain open across a second apply (idempotent open)', async () => {
    const ctx = await compose()
    const { makeWorkbenchService } = await import('../packages/agent-cron-dashboard/src/index.ts')
    const service = makeWorkbenchService(ctx, {})
    await vi.waitFor(() => expect(Object.keys(service.domains)).toHaveLength(7))
    await service.openDomains()
    expect(Object.keys(service.domains)).toHaveLength(7)
    expect(service.domainError).toBeNull()
  })
})

describe('row unmount closes the domains it opened', () => {
  // Storage-layer regression only: this one relies on the storage plugin's own
  // teardown, so it does NOT stand as evidence for the row disposer.
  it('storage teardown closes domains after the row is disposed', async () => {
    const ctx = await compose()
    const { WorkbenchService } = await import('../packages/agent-cron-dashboard/src/index.ts')
    const service = new WorkbenchService(ctx, {})
    await vi.waitFor(() => expect(Object.keys(service.domains)).toHaveLength(7))
    const fingerprints = service.domains.workbench_fingerprints as {
      table(name: string): { put(key: string, value: unknown): Promise<void>; get(key: string): unknown }
    }
    await fingerprints.table('fingerprints').put('sig-unmount', {
      signature: 'sig-unmount',
      recordId: 'rec-unmount',
      count: 1,
      lastSeen: '2026-11-07T00:00:00+08:00',
    })
    expect(fingerprints.table('fingerprints').get('sig-unmount')).toBeDefined()
    // Dispose the row: dsh calls the service's disposer on row unmount.
    await ctx.fiber.dispose()
    expect(service.domainNames()).toHaveLength(7)
    expect(() => fingerprints.table('fingerprints').get('sig-unmount')).toThrow(/closed/)
  })

  it('opens nothing more after disposal (retry timer is cleared)', async () => {
    const ctx = await compose()
    const { WorkbenchService } = await import('../packages/agent-cron-dashboard/src/index.ts')
    const service = new WorkbenchService(ctx, {})
    await vi.waitFor(() => expect(Object.keys(service.domains)).toHaveLength(7))
    await ctx.fiber.dispose()
    const snapshot = Object.keys(service.domains).length
    await new Promise((resolve) => setTimeout(resolve, 1200))
    expect(Object.keys(service.domains).length).toBe(snapshot)
  })
})

describe('row disposer alone closes every domain it opened', () => {
  it('closes each opened domain through the row disposer (recorded fake facility)', async () => {
    // A recording fake facility isolates the row's own disposer: the storage
    // plugin's teardown would otherwise close domains too, and a disposer that
    // did nothing would still look green. The fake records open/close calls.
    const { Context } = await import('@deepseek-ai/cordis')
    const { WorkbenchService, DOMAINS } = await import('../packages/agent-cron-dashboard/src/index.ts')
    const opened: string[] = []
    const closed: string[] = []
    const facility = {
      async open(spec: { name: string }) {
        opened.push(spec.name)
        return {
          async close() {
            closed.push(spec.name)
          },
          table() {
            throw new Error('not used')
          },
        }
      },
      get: () => undefined,
      closeAll: async () => {},
    }
    const ctx = new Context()
    ctx.provide('storageDomain', facility as never)
    const service = new WorkbenchService(ctx, {})
    await vi.waitFor(() => expect(opened).toHaveLength(DOMAINS.length))
    await ctx.fiber.dispose()
    await vi.waitFor(() => expect([...closed].sort()).toEqual([...opened].sort()))
    expect(closed).toHaveLength(DOMAINS.length)
    expect(service.domainNames()).toHaveLength(DOMAINS.length)
  })
})
