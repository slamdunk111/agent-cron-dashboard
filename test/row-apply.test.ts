import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

// Storage domains are single-open per facility; each test closes the ones it
// opened so the next test can open them again on its own composition.

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
