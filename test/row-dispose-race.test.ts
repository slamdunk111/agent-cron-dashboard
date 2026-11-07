import { describe, expect, it, vi } from 'vitest'

/**
 * Unmounting a row while a domain open is still in flight must not lose the
 * domains that the open produces afterwards.
 *
 * The fake facility makes the next open call (after unmount began) answer
 * slowly and records every close, so the test can assert that the disposer
 * waited for it and closed it too.
 */
describe('row unmount during an in-flight open', () => {
  it('closes every domain opened, including those opened after dispose began', async () => {
    const { Context } = await import('@deepseek-ai/cordis')
    const { WorkbenchService, DOMAINS } = await import('../packages/agent-cron-dashboard/src/index.ts')
    const opened: string[] = []
    const closed: string[] = []
    const facility = {
      // Every open takes 40 ms, so the row is mid-open when disposal starts.
      async open(spec: { name: string }) {
        await new Promise((resolve) => setTimeout(resolve, 40))
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
    await new Promise((resolve) => setTimeout(resolve, 100))
    // The dispose must land mid-open; this assertion is what makes the test a race.
    expect(opened.length).toBeGreaterThan(0)
    expect(opened.length).toBeLessThan(DOMAINS.length)
    await ctx.fiber.dispose()
    // The disposer waited for the in-flight open; give it a settled window too.
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(opened.length).toBe(DOMAINS.length)
    expect([...closed].sort()).toEqual([...opened].sort())
  })
})
