/**
 * HTTP transport for the GitCode provider: one request primitive every
 * endpoint goes through, so credential handling, abort and failure mapping
 * live in exactly one place.
 *
 * Measured facts this encodes (`../../docs/gitcode-v5-diff.md`):
 * - `private-token: <token>` is the authentication header; without it the host
 *   answers 400 `Invalid header parameter: private-token, required` (not 401).
 * - Public read covers the `pulls` family only; `/user` always needs the header.
 * - No `X-RateLimit-*` / `Retry-After` headers are sent, so callers back off by
 *   interval rather than by header.
 */
import type { ForgeFailure } from './contracts.ts'

export interface TransportFeatures {
  fetch?: typeof fetch | undefined
  token?: string | undefined
  timeoutMs?: number
  maxOutputBytes?: number
}

export type TransportResult =
  | { readonly ok: true; readonly status: number; readonly text: string }
  | { readonly ok: false; readonly failure: ForgeFailure }

const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024

/** Merge an external abort signal with a deadline into one signal. */
function deadlineSignal(signal: AbortSignal, timeoutMs: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`gitcode request timed out after ${timeoutMs} ms`)), timeoutMs)
  if (timer.unref !== undefined) timer.unref()
  const forward = () => controller.abort(signal.reason)
  if (signal.aborted) forward()
  else signal.addEventListener('abort', forward, { once: true })
  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', forward)
    },
  }
}

/** Map a transport result to a `ForgeFailure`; `status` drives the code. */
function failureOf(status: number, text: string, fallback: string): ForgeFailure {
  const body = (() => {
    try {
      return JSON.parse(text) as Record<string, unknown>
    } catch {
      return undefined
    }
  })()
  const message =
    (typeof body?.error_message === 'string' && body.error_message) ||
    (typeof body?.message === 'string' && body.message) ||
    text.trim().split('\n')[0] ||
    fallback
  if (status === 404) return { code: 'not-found', message }
  // GitCode reports a missing or rejected credential as 400, never 401.
  // Anonymous `/user` answers 403 `no scopes:read_user`; a missing header answers
  // 400 `Invalid header parameter: private-token`.
  if (
    status === 401 ||
    (status === 403 && /no scopes/i.test(message)) ||
    (status === 400 && /private-token|no scopes|invalid token|token/i.test(message))
  ) {
    return { code: 'unauthenticated', message }
  }
  if (status === 429) return { code: 'unavailable', message: `rate limited: ${message}` }
  return { code: 'unavailable', message }
}

/**
 * Fetch one GitCode URL.
 * @param url - absolute URL on the served host.
 * @param features - fetch implementation (injectable for tests), token, limits.
 * @param signal - caller's abort signal.
 * @param accept - `Accept` header, e.g. `application/json` or `text/plain`.
 * @returns text on success, or a mapped `ForgeFailure`.
 */
export async function request(
  url: string,
  features: TransportFeatures,
  signal: AbortSignal,
  accept = 'application/json',
): Promise<TransportResult> {
  const doFetch = features.fetch ?? globalThis.fetch
  if (typeof doFetch !== 'function') {
    return { ok: false, failure: { code: 'unavailable', message: 'no fetch implementation available' } }
  }
  if (signal.aborted) return { ok: false, failure: { code: 'unavailable', message: 'aborted before the request started' } }
  const deadline = deadlineSignal(signal, features.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const headers: Record<string, string> = { Accept: accept, 'User-Agent': 'dsh-forge-gitcode' }
  // The token is read from the environment by the caller and never logged.
  if (features.token !== undefined && features.token.length > 0) headers['private-token'] = features.token
  try {
    // `redirect: 'manual'`: a token must never be forwarded by a redirect the
    // caller's URL did not name (a served host could bounce to any domain).
    const response = await doFetch(url, { method: 'GET', headers, signal: deadline.signal, redirect: 'manual' })
    const max = features.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    // The limit is in bytes, and decoding is fatal so a malformed body becomes a
    // mapped failure instead of a rejection that escapes the request contract.
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > max) {
      return { ok: false, failure: { code: 'too-large', message: `response is ${bytes.byteLength} bytes, limit ${max}` } }
    }
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      return { ok: false, failure: { code: 'unavailable', message: 'response body is not valid UTF-8' } }
    }
    if (response.status >= 300 && response.status < 400) {
      // A redirected read is refused rather than followed, so credentials stay
      // on the host that was asked for.
      return {
        ok: false,
        failure: {
          code: 'unavailable',
          message: `redirected (${response.status}) to ${response.headers.get('location') ?? 'unknown'}; refusing to follow`,
        },
      }
    }
    if (!response.ok) return { ok: false, failure: failureOf(response.status, text, `HTTP ${response.status}`) }
    return { ok: true, status: response.status, text }
  } catch (error) {
    if (signal.aborted) return { ok: false, failure: { code: 'unavailable', message: 'request aborted' } }
    const reason = error instanceof Error ? error.message : String(error)
    return { ok: false, failure: { code: 'unavailable', message: reason } }
  } finally {
    deadline.cancel()
  }
}

/** Parse JSON, mapping a broken body to an `unavailable` failure. */
export function parseJson(text: string): { ok: true; value: unknown } | { ok: false; failure: ForgeFailure } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch (error) {
    return {
      ok: false,
      failure: { code: 'unavailable', message: `unexpected GitCode response: ${error instanceof Error ? error.message : String(error)}` },
    }
  }
}
