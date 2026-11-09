import { describe, expect, it } from 'vitest'
import { SNAPSHOT_MAX_BYTES, SNAPSHOT_PATH, mountP7, snapshotOf } from '../packages/agent-cron-dashboard/src/ui/p7-routes.ts'

/** The Host route contract `dsh-host-webserver` publishes for a resource route. */
interface HostWebServer {
  register(route: { kind: 'exact' | 'prefix'; path: string; resource: (request: Request) => Promise<Response> }): () => void
  port?: number
  host?: string
}

/** Minimal exact/prefix matcher mirroring the host's `match()`. */
function matches(route: { kind: string; path: string }, pathname: string): boolean {
  if (route.kind === 'exact') return pathname === route.path
  return pathname === route.path || pathname.startsWith(`${route.path}/`)
}

describe('the snapshot route speaks the host route contract', () => {
  it('registers the documented path, kind and a resource that answers JSON', async () => {
    const routes: Array<{ kind: 'exact' | 'prefix'; path: string; resource: (request: Request) => Promise<Response> }> = []
    const webServer: HostWebServer = {
      port: 8080,
      host: '127.0.0.1',
      register(route) {
        routes.push(route as never)
        return () => undefined
      },
    }
    const ctx = { get: (key: string) => (key === 'webServer' ? webServer : undefined) }
    const dispose = mountP7(ctx as never)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(routes).toHaveLength(1)
    expect(routes[0]!.path).toBe(SNAPSHOT_PATH)
    expect(matches(routes[0]!, SNAPSHOT_PATH)).toBe(true)
    expect(matches(routes[0]!, `${SNAPSHOT_PATH}/extra`)).toBe(false)
    const response = await routes[0]!.resource(new Request(`http://127.0.0.1:8080${SNAPSHOT_PATH}`))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(response.headers.get('x-workbench-route')).toBe('resource')
    const text = await response.text()
    expect(() => JSON.parse(text) as unknown).not.toThrow()
    expect(text.length).toBeLessThan(SNAPSHOT_MAX_BYTES)
    dispose()
  })

  it('answers with the full six-domain missing list when no domain is open', async () => {
    const routes: Array<{ resource: (request: Request) => Promise<Response> }> = []
    const webServer: HostWebServer = { register(route) { routes.push(route as never); return () => undefined } }
    const ctx = { get: (key: string) => (key === 'webServer' ? webServer : undefined) }
    const dispose = mountP7(ctx as never)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const body = (await (await routes[0]!.resource(new Request(`http://x${SNAPSHOT_PATH}`))).json()) as { missing: string[] }
    expect(body.missing).toHaveLength(6)
    dispose()
  })

  it('hands a snapshot built from a provider when the row exposes one', async () => {
    const snapshot = snapshotOf({}, new Date('2026-11-09T20:40:00.000+08:00'))
    const routes: Array<{ resource: (request: Request) => Promise<Response> }> = []
    const webServer: HostWebServer = { register(route) { routes.push(route as never); return () => undefined } }
    const ctx = {
      get: (key: string) => (key === 'webServer' ? webServer : key === 'workbenchUiSnapshot' ? () => snapshot : undefined),
    }
    const dispose = mountP7(ctx as never)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const body = (await (await routes[0]!.resource(new Request(`http://x${SNAPSHOT_PATH}`))).json()) as { at: string }
    expect(body.at).toBe('2026-11-09T12:40:00.000Z')
    dispose()
  })

  it('never answers anything else when build is cancelled before the microtask', async () => {
    const routes: unknown[] = []
    const webServer: HostWebServer = { register(route) { routes.push(route); return () => undefined } }
    const dispose = mountP7({ get: (key: string) => (key === 'webServer' ? webServer : undefined) } as never)
    dispose()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(routes).toHaveLength(0)
  })
})

describe('the route disposer under a cancelled build', () => {
  it('disposes the route at once when the build completes after cancellation', async () => {
    const disposed: string[] = []
    const routes: Array<unknown> = []
    const webServer: HostWebServer = {
      register(route) {
        routes.push(route)
        return () => {
          disposed.push((route as { path: string }).path)
        }
      },
    }
    const ctx = { get: (key: string): unknown => (key === 'webServer' ? webServer : undefined) }
    const dispose = mountP7(ctx as never)
    await Promise.resolve()
    dispose()
    expect(disposed).toEqual([SNAPSHOT_PATH])
    expect(routes).toHaveLength(1)
  })

  it('swallows a rejected build instead of leaking an unhandled rejection', async () => {
    const ctx = {
      get: (key: string): unknown => {
        if (key !== 'webServer') return undefined
        return {
          register(): () => void {
            throw new Error('duplicate exact route')
          },
        }
      },
    }
    const unhandled: unknown[] = []
    const onUnhandled = (error: unknown) => unhandled.push(error)
    process.on('unhandledRejection', onUnhandled)
    const dispose = mountP7(ctx as never)
    await new Promise((resolve) => setTimeout(resolve, 10))
    process.off('unhandledRejection', onUnhandled)
    expect(unhandled).toHaveLength(0)
    dispose()
  })
})
