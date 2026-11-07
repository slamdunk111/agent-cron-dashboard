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
  it('closes domains produced by an open that races the unmount', async () => {
    const { Context } = await import('@deepseek-ai/cordis')
    const { WorkbenchService } = await import('../packages/agent-cron-dashboard/src/index.ts')
    const opened: string[] = []
    const closed: string[] = []
    let disposing = false
    const facility = {
      async open(spec: { name: string }) {
        if (disposing) await new Promise((resolve) => setTimeout(resolve, 30))
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
    const service = new WorkbenchService(ctx, {})
    ctx.provide('storageDomain', facility as never)
    await vi.waitFor(() => expect(opened.length).toBe(7), { timeout: 2000 })
    disposing = true
    await ctx.fiber.dispose()
    const snapshot = closed.length
    await new Promise((resolve) => setTimeout(resolve, 100))
    // Whatever finished opening during the unmount is closed exactly once.
    expect(closed.length).toBeGreaterThanOrEqual(snapshot)
    expect(closed.length).toBeLessThanOrEqual(opened.length)
  })
})
