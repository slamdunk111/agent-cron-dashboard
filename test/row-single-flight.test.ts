import { describe, expect, it } from 'vitest'

/**
 * Concurrent open attempts must not open the same domain twice: with a slow
 * facility, a call that starts while another open is still in flight joins it
 * instead of starting a second pass (which the facility would reject with
 * `already-open` and whose later handle would replace the first).
 */
describe('openDomains single-flight', () => {
  it('never opens one domain twice when calls overlap', async () => {
    const { Context } = await import('@deepseek-ai/cordis')
    const { WorkbenchService } = await import('../packages/agent-cron-dashboard/src/index.ts')
    const calls: string[] = []
    const facility = {
      async open(spec: { name: string }) {
        calls.push(spec.name)
        await new Promise((resolve) => setTimeout(resolve, 200))
        return {
          async close() {},
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
    // A retry-style call starting 100 ms into the first open must join it.
    await new Promise((resolve) => setTimeout(resolve, 100))
    await service.openDomains().catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, 1200))
    const counts = new Map<string, number>()
    for (const name of calls) counts.set(name, (counts.get(name) ?? 0) + 1)
    expect([...counts.values()].filter((count) => count > 1)).toHaveLength(0)
    expect(counts.size).toBe(8)
  })
})
