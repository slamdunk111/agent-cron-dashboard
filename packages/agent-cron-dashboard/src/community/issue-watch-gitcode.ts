/**
 * GitCode side of the issue poller (P3, plan task 2; ADR P3-1).
 *
 * **Probe first** (`../docs/probes/p3-gitcode-issues.md`, measured
 * 2026-11-08T18:16:09..18:25:11+08:00): api/v5 has two search-shaped reads and
 * they disagree.
 *
 * | endpoint | rows for the subject | notes |
 * |---|---|---|
 * | `GET /api/v5/search/issues?q=author:<me>` | 22 | rows carry **no `user` field**, `per_page` > 50 → 400 |
 * | `GET /api/v5/user/issues?filter=created&state=<…>` | 61 (26 open + 35 closed) | token required (anonymous 400 `private-token`), `per_page` up to 500 accepted, `state` defaults to open |
 *
 * Neither includes the other, and the response body cannot explain why, so the
 * poller takes the **complete-looking** read (`/user/issues`) as the seed and
 * exposes the search read as capability only (ADR §5 "coverage unknown"). Newly
 * discovered issues are enumerated through the per-repository endpoint.
 *
 * Comments are read with `GET /repos/{o}/{r}/issues/{n}/comments?per_page=1&page=1`:
 * measured **descending** (newest first), so page 1 is the last comment and page 2
 * is the one before it (both verified 2026-11-08T18:24Z). No CTag/ETag header
 * reaches us, so the comments read is unconditional when the count or the
 * `updated_at` moved.
 */
import type { HttpGet } from './http-get.ts'
import type { IssueDetail, IssueFailure, IssueListAnswer, LastComment, ListedIssue, PollResult } from './issue-types.ts'
import type { HttpGetResponse } from './http-get.ts'
import { fetchHttpGet, parseJson } from './http-get.ts'

/** Page size the GitCode issue list accepts (measured: any value, 500 included). */
export const GITCODE_ISSUE_PER_PAGE = 100
/** Page ceiling per repository read; the list there is small and pages are bounded. */
export const GITCODE_REPO_MAX_PAGES = 3

/** One GitCode issue row, as both list endpoints return it. */
export interface GitcodeIssueJson {
  /** **String** on api/v5, unlike GitHub's number. */
  readonly number?: number | string
  readonly title?: string
  readonly state?: string
  readonly updated_at?: string
  readonly comments?: number
  readonly labels?: ReadonlyArray<{ readonly name?: string } | string>
  readonly assignees?: ReadonlyArray<{ readonly login?: string }>
  readonly user?: { readonly login?: string }
  readonly repository?: { readonly full_name?: string; readonly path?: string; readonly name?: string }
}

/** One comment row of api/v5 (newest first on page 1). */
export interface GitcodeCommentJson {
  readonly user?: { readonly login?: string }
  readonly created_at?: string
}

/** Options of {@link GitcodeIssueReader}. */
export interface GitcodeIssueReaderOptions {
  /** Token VALUE (resolved by `tokenOf` before entering this module); never logged. */
  readonly token: string
  readonly transport?: HttpGet
  readonly now?: () => Date
  /** api/v5 root without a trailing slash. */
  readonly apiRoot?: string
  readonly log?: (line: string) => void
}

/** api/v5 numbers arrive as strings; accept both and refuse anything else. */
export function issueNumberOf(raw: number | string | undefined): number | undefined {
  if (typeof raw === 'number') return Number.isInteger(raw) && raw > 0 ? raw : undefined
  if (typeof raw !== 'string') return undefined
  const value = Number(raw)
  return Number.isInteger(value) && value > 0 ? value : undefined
}

/** Labels arrive as objects (`{name}`) on every measured answer; strings tolerated. */
export function labelNamesOf(labels: GitcodeIssueJson['labels']): string[] {
  return (labels ?? []).flatMap((label) => (typeof label === 'string' ? [label] : typeof label.name === 'string' ? [label.name] : []))
}

/** Map status codes onto the poller's failure codes (api/v5 has no Retry-After). */
function failureOf(status: number): IssueFailure {
  if (status === 404) return { code: 'not-found', message: 'HTTP 404' }
  if (status === 401 || status === 403) return { code: 'unauthenticated', message: `HTTP ${String(status)}` }
  if (status === 429) return { code: 'rate-limited', message: 'HTTP 429' }
  return { code: 'unavailable', message: `HTTP ${String(status)}` }
}

/**
 * GitCode api/v5 reads for "my issues".
 *
 * The token travels only in the `private-token` header; error text quoting a
 * status is fixed, so no response body can echo it into a log line.
 */
export class GitcodeIssueReader {
  private readonly options: GitcodeIssueReaderOptions
  private readonly transport: HttpGet
  private readonly apiRoot: string

  constructor(options: GitcodeIssueReaderOptions) {
    this.options = options
    this.transport = options.transport ?? fetchHttpGet()
    this.apiRoot = (options.apiRoot ?? 'https://gitcode.com/api/v5').replace(/\/$/, '')
  }

  private async get(url: string): Promise<{ response: HttpGetResponse } | { failure: IssueFailure }> {
    try {
      const response = await this.transport.get(url, { Accept: 'application/json', 'private-token': this.options.token })
      if (response.status !== 200) return { failure: failureOf(response.status) }
      return { response }
    } catch (error) {
      return { failure: { code: 'unavailable', message: `request failed: ${error instanceof Error ? error.message : String(error)}` } }
    }
  }

  /** Parse one list row into a {@link ListedIssue}, or undefined when unusable. */
  private listed(row: GitcodeIssueJson, fromConfig: boolean): ListedIssue | undefined {
    const number = issueNumberOf(row.number)
    if (number === undefined) return undefined
    let owner: string | undefined
    let repo: string | undefined
    // The `/user/issues` shape carries `repository.full_name`; the
    // per-repository read does not, so its caller substitutes the path.
    const full = row.repository?.full_name
    if (typeof full === 'string' && full.includes('/')) {
      ;[owner, repo] = full.split('/', 2)
    }
    if (owner === undefined || repo === undefined || owner.length === 0 || repo.length === 0) return undefined
    return { platform: 'gitcode', owner, repo, number, updatedAt: typeof row.updated_at === 'string' ? row.updated_at : '', fromConfig }
  }

  /**
   * The seed read: every issue the token's user created, open and closed.
   * @returns rows from `/user/issues`; paging stops at the first page that is
   *   not exactly full (the endpoint offsets `page * per_page`, measured).
   */
  async listMine(state: 'all' | 'open' = 'all'): Promise<PollResult<IssueListAnswer>> {
    const rows: ListedIssue[] = []
    let pages = 0
    for (let page = 1; ; page += 1) {
      const url = `${this.apiRoot}/user/issues?filter=created&state=${state}&per_page=${String(GITCODE_ISSUE_PER_PAGE)}&page=${String(page)}`
      const answer = await this.get(url)
      if ('failure' in answer) return { ok: false, failure: answer.failure }
      const body = parseJson(answer.response.text)
      if (!Array.isArray(body)) return { ok: false, failure: { code: 'unavailable', message: `page ${String(page)} is not a JSON list` } }
      pages += 1
      for (const row of body as GitcodeIssueJson[]) {
        const entry = this.listed(row, false)
        if (entry !== undefined) rows.push(entry)
      }
      if (body.length < GITCODE_ISSUE_PER_PAGE) break
      if (page === GITCODE_REPO_MAX_PAGES) return { ok: false, failure: { code: 'unavailable', message: `${String(GITCODE_REPO_MAX_PAGES)} full pages read (${String(rows.length)} items); older issues were not listed` } }
    }
    return { ok: true, value: { items: rows, totalCount: rows.length, lastPage: pages } }
  }

  /**
   * One page of a repository's issues (new-issue enumeration in `watch.repos[]`).
   * @returns items carrying the path this call read (the row has no `owner`).
   */
  async listRepo(owner: string, repo: string, page: number, state: 'all' | 'open' | 'closed' = 'all'): Promise<PollResult<IssueListAnswer>> {
    const url = `${this.apiRoot}/repos/${owner}/${repo}/issues?state=${state}&per_page=${String(GITCODE_ISSUE_PER_PAGE)}&page=${String(page)}`
    const answer = await this.get(url)
    if ('failure' in answer) return { ok: false, failure: answer.failure }
    const body = parseJson(answer.response.text)
    if (!Array.isArray(body)) return { ok: false, failure: { code: 'unavailable', message: `page ${String(page)} is not a JSON list` } }
    const items: ListedIssue[] = []
    for (const row of body as GitcodeIssueJson[]) {
      const number = issueNumberOf(row.number)
      if (number === undefined) continue
      items.push({ platform: 'gitcode', owner, repo, number, updatedAt: typeof row.updated_at === 'string' ? row.updated_at : '', fromConfig: true })
    }
    return { ok: true, value: { items, lastPage: body.length < GITCODE_ISSUE_PER_PAGE ? page : undefined } }
  }

  /** Read one issue's detail (state/labels/comments/`updated_at`; assignees measured empty). */
  async detail(owner: string, repo: string, number: number): Promise<PollResult<IssueDetail>> {
    const url = `${this.apiRoot}/repos/${owner}/${repo}/issues/${String(number)}`
    const answer = await this.get(url)
    if ('failure' in answer) return { ok: false, failure: answer.failure }
    const body = parseJson(answer.response.text) as GitcodeIssueJson | undefined
    if (body === undefined || typeof body.state !== 'string') {
      return { ok: false, failure: { code: 'unavailable', message: 'issue payload is not a JSON object with state' } }
    }
    return {
      ok: true,
      value: {
        title: typeof body.title === 'string' ? body.title : '',
        state: body.state === 'closed' ? 'closed' : 'open',
        labels: labelNamesOf(body.labels),
        assignees: (body.assignees ?? []).flatMap((entry) => (typeof entry.login === 'string' ? [entry.login] : [])),
        comments: typeof body.comments === 'number' && body.comments >= 0 ? body.comments : 0,
        updatedAt: typeof body.updated_at === 'string' ? body.updated_at : '',
      },
    }
  }

  /**
   * Last comment of an issue with `count > 0` (page 1 is the newest, measured).
   */
  async lastComment(owner: string, repo: string, number: number, count: number): Promise<PollResult<LastComment>> {
    if (count <= 0) return { ok: true, value: { by: null, at: null } }
    const url = `${this.apiRoot}/repos/${owner}/${repo}/issues/${String(number)}/comments?per_page=1&page=1`
    const answer = await this.get(url)
    if ('failure' in answer) return { ok: false, failure: answer.failure }
    const body = parseJson(answer.response.text)
    if (!Array.isArray(body) || body.length === 0) {
      return { ok: false, failure: { code: 'unavailable', message: 'comments page 1 is empty' } }
    }
    const row = body[0] as GitcodeCommentJson
    return { ok: true, value: { by: typeof row.user?.login === 'string' ? row.user.login : null, at: typeof row.created_at === 'string' ? row.created_at : null } }
  }
}

