/**
 * GitHub side of the issue poller (P3, plan task 1).
 *
 * Three reads per issue, each cheaper than the previous one when nothing
 * changed (measured 2026-11-08, `../docs/probes/p3-gitcode-issues.md` §2):
 *
 * 1. **list** — `GET /search/issues?q=author:<me>+is:issue`, 50 per page.
 *    Counts do **not** come from here: a search item carries `comments` but a
 *    PR masquerading in the result would too, and one page is not the whole
 *    truth (counts come from the detail read).
 * 2. **detail** — `GET /repos/{o}/{r}/issues/{n}`. This is the only endpoint
 *    that answers `304` to `If-None-Match` (the search endpoint sends no ETag
 *    and `cache-control: no-cache`), so the ETag lives here.
 * 3. **comments** — only when the detail's `comments > 0` and its
 *    `updated_at` moved since the last poll: `GET .../comments?per_page=1&page=1`
 *    is the **oldest** comment (ascending), so the last one is page
 *    `ceil(comments/1)` = `comments`. A detail answer that repeats the ETag
 *    skips this read entirely.
 *
 * Rate limits: `search` allows 30 requests/minute, core 5000/hour. The
 * transport reports `x-ratelimit-remaining` / `Retry-After`; this module
 * turns them into a {@link GithubPollOutcome} the scheduler backs off from.
 * The token is never read here (`gh` owns GitHub credentials); whatever the
 * transport injects is treated as opaque.
 */
import type { HttpGet, HttpGetResponse } from './http-get.ts'
import { parseJson, rateLimitRemaining, rateLimitResetMs, retryAfterMs } from './http-get.ts'
import type { IssueDetail, IssueFailure, IssueListAnswer, LastComment, ListedIssue, PollResult } from './issue-types.ts'

/** Maximum results GitHub returns per search page (documented ceiling). */
export const GITHUB_LIST_PER_PAGE = 50
/** Repositories per query: no query counts toward the search quota for at least that long. */
export const GITHUB_REPO_QUERY_MIN = 60_000

/** One `GET /search/issues` item, narrowed. */
export interface GithubSearchItem {
  readonly number?: number
  readonly state?: string
  readonly updated_at?: string
  readonly comments?: number
  readonly html_url?: string
  readonly repository_url?: string
  /** Present on pull requests, absent on issues; a safety check, not a filter. */
  readonly pull_request?: unknown
  readonly user?: { readonly login?: string }
}

/** One `GET /repos/{o}/{r}/issues/{n}` answer, narrowed. */
export interface GithubIssueJson {
  readonly number?: number
  readonly title?: string
  readonly state?: string
  readonly updated_at?: string
  readonly comments?: number
  readonly labels?: ReadonlyArray<{ readonly name?: string } | string>
  readonly assignees?: ReadonlyArray<{ readonly login?: string }>
  readonly pull_request?: unknown
}

/** One comment row, narrowed. */
export interface GithubCommentJson {
  readonly user?: { readonly login?: string }
  readonly created_at?: string
}

/** A failed read: the failure plus the waits the host asked for (`Retry-After`, quota reset). */
export interface GithubFailure {
  readonly ok: false
  readonly failure: IssueFailure
  /** `Retry-After` from the host, when it said. */
  readonly retryAfterMs?: number
  /** `x-ratelimit-reset` minus now, when the host said. */
  readonly resetInMs?: number
}

/** Options of {@link GithubIssueReader}. */
export interface GithubIssueReaderOptions {
  /** Account whose authored issues are listed (already resolved by `effectiveLogin`). */
  readonly login: string
  readonly transport: HttpGet
  readonly now?: () => Date
  /** Request headers the transport adds (credential of the host's choice, if any). */
  readonly headers?: Readonly<Record<string, string>>
  readonly log?: (line: string) => void
}

/** Split `repositories/123` / `repos/o/r` `repository_url` into owner/name. */
export function repoFromApiUrl(url: string | undefined): { owner: string; repo: string } | undefined {
  if (typeof url !== 'string') return undefined
  const match = /(?:repositories\/(\d+)|repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+))$/.exec(url)
  if (match === null) return undefined
  if (match[1] !== undefined) return undefined
  return { owner: match[2], repo: match[3] }
}

/** Map an HTTP status onto the poller's failure codes. */
function failureOf(status: number, response: HttpGetResponse, now: number): IssueFailure {
  if (status === 404) return { code: 'not-found', message: 'HTTP 404' }
  const retry = retryAfterMs(response.headers, now)
  if (status === 429) return { code: 'rate-limited', message: `HTTP 429${retry === undefined ? '' : ` Retry-After ${String(retry)}ms`}`, retryAfterMs: retry }
  if (status === 403) {
    // GitHub answers 403 both for an exhausted quota and for a refusal; only
    // the headers can tell them apart, so only a zeroed quota is a rate limit.
    const remaining = rateLimitRemaining(response.headers)
    const resetAt = rateLimitResetMs(response.headers)
    if (remaining === 0 || retry !== undefined) {
      return {
        code: 'rate-limited',
        message: `HTTP 403${retry === undefined ? '' : ` Retry-After ${String(retry)}ms`}${remaining === undefined ? '' : ` remaining ${String(remaining)}`}`,
        retryAfterMs: retry ?? (resetAt === undefined ? undefined : Math.max(0, resetAt - now)),
      }
    }
    return { code: 'unauthenticated', message: 'HTTP 403' }
  }
  if (status === 401) return { code: 'unauthenticated', message: 'HTTP 401' }
  return { code: 'unavailable', message: `HTTP ${String(status)}` }
}

/** Read the `rel="last"` page from a `Link` header. */
export function lastPageOfLink(link: string | undefined): number | undefined {
  if (typeof link !== 'string') return undefined
  const match = /<[^>]*?page=(\d+)[^>]*>;\s*rel="last"/.exec(link)
  return match === null ? undefined : Number(match[1])
}

/**
 * GitHub REST reads for "my issues".
 *
 * Every method returns a {@link PollResult}; none throws, so a listener can
 * turn a failure into a health line and keep going.
 */
export class GithubIssueReader {
  private readonly options: GithubIssueReaderOptions
  private readonly now: () => Date
  private searchRemaining: number | undefined

  constructor(options: GithubIssueReaderOptions) {
    this.options = options
    this.now = options.now ?? (() => new Date())
  }

  /** Requests left in the search window, as the last search answer said. */
  get searchQuotaRemaining(): number | undefined {
    return this.searchRemaining
  }

  /** One `GET <url>`; maps thrown transport errors and bad statuses onto failures. */
  private async get(url: string, extra: Readonly<Record<string, string>> = {}): Promise<{ response: HttpGetResponse } | { failure: GithubFailure }> {
    try {
      const response = await this.options.transport.get(url, { ...this.options.headers, ...extra, Accept: 'application/vnd.github+json' })
      const now = this.now().getTime()
      const remaining = rateLimitRemaining(response.headers)
      const resetAt = rateLimitResetMs(response.headers)
      if (response.status !== 200 && response.status !== 304) {
        const failure = failureOf(response.status, response, now)
        return { failure: { ok: false, failure, retryAfterMs: retryAfterMs(response.headers, now), resetInMs: resetAt === undefined ? undefined : Math.max(0, resetAt - now) } }
      }
      // The scheduler reads {@link searchQuotaRemaining} after every list call
      // and waits for `resetAt` when it hits zero; a zero-remaining answer is
      // still a good answer and must not fail the round.
      if (remaining !== undefined && url.includes('/search/issues')) this.searchRemaining = remaining
      return { response }
    } catch (error) {
      return { failure: { ok: false, failure: { code: 'unavailable', message: `request failed: ${error instanceof Error ? error.message : String(error)}` } } }
    }
  }

  /**
   * List one page of authored issues.
   * @param page - 1-based page.
   * @returns sorted-by-number items, or the host's refusal.
   */
  async listPage(page: number): Promise<PollResult<IssueListAnswer> | GithubFailure> {
    const url = `https://api.github.com/search/issues?q=${encodeURIComponent(`author:${this.options.login} is:issue`)}&per_page=${String(GITHUB_LIST_PER_PAGE)}&page=${String(page)}`
    const answer = await this.get(url)
    if ('failure' in answer) return answer.failure
    const { response } = answer
    if (response.status === 304) {
      // Search sends no ETag, so a 304 here is a host quirk: report it instead
      // of inventing a "nothing changed" answer.
      return { ok: false, failure: { code: 'unavailable', message: 'search answered 304 without an If-None-Match request' } }
    }
    const body = parseJson(response.text) as { total_count?: number; items?: GithubSearchItem[]; incomplete_results?: boolean } | undefined
    if (body === undefined || !Array.isArray(body.items)) {
      return { ok: false, failure: { code: 'unavailable', message: 'search payload is not a JSON object with items' } }
    }
    const items: ListedIssue[] = []
    for (const item of body.items) {
      if (typeof item.number !== 'number') continue
      // The query is `is:issue`, but a PR can still slip into a result set; it
      // belongs to the PR watch, never to the issue poller.
      if (item.pull_request !== undefined && item.pull_request !== null) continue
      const repo = repoFromApiUrl(item.repository_url)
      if (repo === undefined) continue
      items.push({ platform: 'github', owner: repo.owner, repo: repo.repo, number: item.number, updatedAt: item.updated_at ?? '', fromConfig: false })
    }
    const remaining = rateLimitRemaining(response.headers)
    this.searchRemaining = remaining
    return {
      ok: true,
      value: {
        items,
        totalCount: typeof body.total_count === 'number' ? body.total_count : undefined,
        lastPage: lastPageOfLink(response.headers['link']),
      },
    }
  }

  /**
   * Read one issue's detail, conditionally when an ETag from a previous poll exists.
   * @returns `unchanged` when the host answers 304 (no write, no comment read).
   */
  async detail(ref: { readonly owner: string; readonly repo: string; readonly number: number }, etag: string | undefined): Promise<PollResult<IssueDetail | 'unchanged'> | GithubFailure> {
    const url = `https://api.github.com/repos/${ref.owner}/${ref.repo}/issues/${String(ref.number)}`
    const answer = await this.get(url, etag === undefined ? {} : { 'If-None-Match': etag })
    if ('failure' in answer) return answer.failure
    const { response } = answer
    if (response.status === 304) return { ok: true, value: 'unchanged' }
    const body = parseJson(response.text) as GithubIssueJson | undefined
    if (body === undefined || typeof body.state !== 'string') {
      return { ok: false, failure: { code: 'unavailable', message: 'issue payload is not a JSON object with state' } }
    }
    if (body.pull_request !== undefined && body.pull_request !== null) {
      return { ok: false, failure: { code: 'unavailable', message: 'the number is a pull request, not an issue' } }
    }
    const value: IssueDetail = {
      title: typeof body.title === 'string' ? body.title : '',
      state: body.state === 'closed' ? 'closed' : 'open',
      labels: (body.labels ?? []).flatMap((label) => (typeof label === 'string' ? [label] : typeof label.name === 'string' ? [label.name] : [])),
      assignees: (body.assignees ?? []).flatMap((entry) => (typeof entry.login === 'string' ? [entry.login] : [])),
      comments: typeof body.comments === 'number' && body.comments >= 0 ? body.comments : 0,
      updatedAt: typeof body.updated_at === 'string' ? body.updated_at : '',
      etag: response.headers['etag'],
    }
    return { ok: true, value }
  }

  /**
   * Last comment of an issue with `count > 0`.
   * @param count - `comments` from the detail answer; the page number is the count
   *   because `per_page=1` ascending.
   */
  async lastComment(ref: { readonly owner: string; readonly repo: string; readonly number: number }, count: number): Promise<PollResult<LastComment> | GithubFailure> {
    if (count <= 0) return { ok: true, value: { by: null, at: null } }
    const url = `https://api.github.com/repos/${ref.owner}/${ref.repo}/issues/${String(ref.number)}/comments?per_page=1&page=${String(count)}`
    const answer = await this.get(url)
    if ('failure' in answer) return answer.failure
    const body = parseJson(answer.response.text)
    if (!Array.isArray(body) || body.length === 0) {
      // A deleted comment leaves the page empty; the count is stale, not a crash.
      return { ok: false, failure: { code: 'unavailable', message: `comments page ${String(count)} is empty` } }
    }
    const row = body[0] as GithubCommentJson
    return { ok: true, value: { by: typeof row.user?.login === 'string' ? row.user.login : null, at: typeof row.created_at === 'string' ? row.created_at : null } }
  }
}

