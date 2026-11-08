import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fetchHttpGet } from '../packages/agent-cron-dashboard/src/community/http-get.ts'

/** Answer of one local request the tests can assert on. */
export interface ServedRequest {
  readonly method: string
  readonly url: string
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
}

/**
 * Run `fetchHttpGet()` against a loopback server and return the request it made.
 * @param handler - writes the single response.
 * @returns the request line and headers the transport sent.
 */
export async function serveOnce(handler: (response: import('node:http').ServerResponse) => void): Promise<ServedRequest> {
  const server = createServer((request, response) => {
    handler(response)
    response.end()
  })
  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', () => resolvePromise()))
  const port = (server.address() as AddressInfo).port
  let seen: ServedRequest | undefined
  server.on('request', (request) => {
    seen = { method: request.method ?? '', url: request.url ?? '', headers: { ...request.headers } }
  })
  await fetchHttpGet().get(`http://127.0.0.1:${String(port)}/probe`, { Accept: 'application/json', 'private-token': 'x' })
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))
  if (seen === undefined) throw new Error('the loopback server saw no request')
  return seen
}

/**
 * Fetch once through `fetchHttpGet()` and return the answer (status/text/headers),
 * so a redirecting server can be asserted to have been refused rather than followed.
 */
export async function serveStatus(handler: (response: import('node:http').ServerResponse) => void): Promise<{ status: number; text: string; headers: Record<string, string> }> {
  const server = createServer((_request, response) => {
    handler(response)
    response.end()
  })
  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', () => resolvePromise()))
  const port = (server.address() as AddressInfo).port
  try {
    return await fetchHttpGet().get(`http://127.0.0.1:${String(port)}/probe`, {})
  } finally {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))
  }
}
