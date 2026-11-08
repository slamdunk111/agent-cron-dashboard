/**
 * Plain GET with a deadline, shared by the two issue readers (P3).
 *
 * Like `identity.ts` and `seeding.ts` it spawns no shell and never follows a
 * redirect (`redirect: 'manual'`): a 3xx is returned as its status and treated
 * as a failure by the caller, so a hostile redirect cannot move the token to
 * another host.
 */
export interface HttpGetResponse {
  readonly status: number
  readonly text: string
  /** Response headers, lower-cased keys; only the ones the readers ask for. */
  readonly headers: Readonly<Record<string, string>>
}

/** HTTP client, injectable so tests never touch the network. */
export interface HttpGet {
  get(url: string, headers: Readonly<Record<string, string>>): Promise<HttpGetResponse>
}

/** Header names the pollers read (ETag/If-None-Match, rate limits, retries). */
const WANTED_HEADERS = ['etag', 'last-modified', 'link', 'retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'x-ratelimit-resource'] as const

/**
 * Default client: one `fetch` GET with a 20 s deadline.
 * @param userAgent - identifies the plugin to both hosts.
 * @returns a client usable with either reader.
 */
export function fetchHttpGet(userAgent = 'agent-cron-dashboard'): HttpGet {
  return {
    async get(url, headers) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 20_000)
      if (timer.unref !== undefined) timer.unref()
      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: { ...headers, 'User-Agent': userAgent },
          signal: controller.signal,
          redirect: 'manual',
        })
        const picked: Record<string, string> = {}
        for (const name of WANTED_HEADERS) {
          const value = response.headers.get(name)
          if (value !== null) picked[name] = value
        }
        return { status: response.status, text: await response.text(), headers: picked }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

/** `JSON.parse` that answers undefined instead of throwing (hosts can answer HTML). */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/** Milliseconds `Retry-After` asks for (seconds or HTTP-date); undefined when absent or unparsable. */
export function retryAfterMs(headers: Readonly<Record<string, string>>, now: number): number | undefined {
  const raw = headers['retry-after']
  if (raw === undefined || raw.length === 0) return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const at = Date.parse(raw)
  return Number.isNaN(at) ? undefined : Math.max(0, at - now)
}

/** Remaining requests in the current window (`x-ratelimit-remaining`), or undefined. */
export function rateLimitRemaining(headers: Readonly<Record<string, string>>): number | undefined {
  const raw = headers['x-ratelimit-remaining']
  if (raw === undefined) return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

/** Epoch milliseconds `x-ratelimit-reset` names, or undefined. */
export function rateLimitResetMs(headers: Readonly<Record<string, string>>): number | undefined {
  const raw = headers['x-ratelimit-reset']
  if (raw === undefined) return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value * 1000 : undefined
}
