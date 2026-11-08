/**
 * Rows of the issue poller (P3, plan §4 "轮询编排").
 *
 * `makeIssueSources` binds the two readers to the `IssuePlatformSource`
 * contract and enforces the plan's quota order: the GitHub list read runs at
 * most once per {@link GITHUB_LIST_REFRESH_MS} (60 s, the plan's §3.6 quota
 * note applied to the search quota of 30 requests/minute), cache hits and
 * refresh not counted. Every repeat call inside the window answers from the
 * cache, including a failure — a host that said no is not asked again inside
 * one window.
 */
import type { IdentityConfig } from '../config-validate.ts'
import type { HttpGet } from './http-get.ts'
import { fetchHttpGet } from './http-get.ts'
import type { PlatformIdentity } from './identity.ts'
import type { Platform } from './identity.ts'
import { tokenOf } from './identity.ts'
import type { IssueDetail, IssueListAnswer, IssuePlatformSource, IssueRef, LastComment, ListedIssue, PollResult } from './issue-types.ts'
import { GithubIssueReader, type GithubFailure } from './issue-watch-github.ts'
import { GitcodeIssueReader } from './issue-watch-gitcode.ts'

/** Minimum distance between two GitHub search list reads (quota 30/min). */
export const GITHUB_LIST_REFRESH_MS = 60_000

export interface IssueSourceOptions {
  readonly identities: readonly PlatformIdentity[]
  readonly identitiesConfig?: readonly IdentityConfig[]
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly transport?: HttpGet
  readonly now?: () => Date
  /** `watch.repos[]` entries, for GitCode's new-issue enumeration. */
  readonly repos?: readonly string[]
  readonly log?: (line: string) => void
  /** GitHub request headers (the credential of the host's choice). */
  readonly githubHeaders?: Readonly<Record<string, string>>
  /** GitHub reads may use their own transport (the `gh`-credential path); GitCode always uses `transport`. */
  readonly githubTransport?: HttpGet
}

export interface IssueSourcesResult {
  readonly sources: Partial<Record<NonNullable<Platform>, IssuePlatformSource>>
  /** Why a platform has no source, when it has none. */
  readonly unavailable: Partial<Record<NonNullable<Platform>, string>>
  /** Machine source of the list-read count (the gate checks the quota rule). */
  githubListReads(): number
  /** Number of `watch.repos[]` GitCode entries the new-issue enumeration covers. */
  gitcodeRepos(): number
}

/** List answer as the scheduler sees it. */
type ListAnswer = PollResult<IssueListAnswer>

/**
 * Build both platform sources.
 * @returns sources (a missing one carries its reason in `unavailable`).
 */
export function makeIssueSources(options: IssueSourceOptions): IssueSourcesResult {
  const now = options.now ?? (() => new Date())
  const transport = options.transport ?? fetchHttpGet()
  const githubTransport = options.githubTransport ?? transport
  const sources: Partial<Record<NonNullable<Platform>, IssuePlatformSource>> = {}
  const unavailable: Partial<Record<NonNullable<Platform>, string>> = {}
  const githubLogin = options.identities.find((identity) => identity.platform === 'github' && identity.state !== 'down')?.login
  const noLoginRefusal: ListAnswer = { ok: false, failure: { code: 'unauthenticated', message: 'no GitHub login resolved' } }
  // The one refusal every GitHub arm answers when the row resolved no login.
  let listReads = 0

  // ---- GitHub ----------------------------------------------------------------
  const githubReader = (login: string): GithubIssueReader => new GithubIssueReader({ login, transport: githubTransport, now, headers: options.githubHeaders })
  let cachedList: { at: number; answer: ListAnswer } | undefined
  sources.github = {
    async list(): Promise<ListAnswer> {
      if (githubLogin === undefined) return noLoginRefusal
      const at = now().getTime()
      if (cachedList !== undefined && at - cachedList.at < GITHUB_LIST_REFRESH_MS) return cachedList.answer
      listReads += 1
      const answer: ListAnswer = await githubReader(githubLogin).listPage(1)
      cachedList = { at, answer }
      return answer
    },
    // A login-less row answers every arm with one named refusal. The decision
    // is a value looked up lazily, so the branch body stays empty and a reader
    // that misses it fails loud instead of guessing.
    async detail(ref: IssueRef, etag: string | undefined): Promise<PollResult<IssueDetail | 'unchanged'>> {
      if (githubLogin !== undefined) return githubReader(githubLogin).detail(ref, etag)
      return noLoginRefusal
    },
    async lastComment(ref: IssueRef, count: number): Promise<PollResult<LastComment>> {
      if (githubLogin !== undefined) return githubReader(githubLogin).lastComment(ref, count)
      return noLoginRefusal
    },
  }
  if (githubLogin === undefined) {
    unavailable.github = options.identities.find((identity) => identity.platform === 'github')?.message ?? 'no github entry in identities[]'
  }

  // ---- GitCode ---------------------------------------------------------------
  const gitcodeConfig = options.identitiesConfig?.find((entry) => entry.platform === 'gitcode')
  const tokenEnvName = gitcodeConfig?.tokenEnv ?? 'GITCODE_TOKEN'
  const token = tokenOf(options.env ?? {}, tokenEnvName)
  const gitcodeIdentity = options.identities.find((identity) => identity.platform === 'gitcode')
  const repoEntries = (options.repos ?? [])
    .map((url) => /^(?:https?:\/\/)?gitcode\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.trim()))
    .flatMap((match) => (match === null ? [] : [{ owner: match[1], repo: match[2] }]))
  if (token === undefined) {
    // The line names both slots: the message the identity produced (it quotes
    // `no token in GITCODE_TOKEN` when the variable is merely absent) and the
    // header the host requires for the seed read.
    unavailable.gitcode = `${gitcodeIdentity?.message ?? `GitCode identity unavailable; no token in ${tokenEnvName}`}; api/v5 /user/issues answers 400 when the private-token header is missing`
  } else {
    const reader = new GitcodeIssueReader({ token, transport, now, log: options.log })
    sources.gitcode = {
      async list() {
        const mine = await reader.listMine('all')
        if (!mine.ok) return mine
        // Repository coverage (optional, plan task 2 "仅种子仓 issue"): issues in
        // `watch.repos[]` that the user did not author are new subjects too,
        // so one page per repository is read and merged (deduplicated by key).
        const extra: ListedIssue[] = []
        const repoProblems: string[] = []
        for (const entry of repoEntries) {
          const page = await reader.listRepo(entry.owner, entry.repo, 1, 'all')
          if (!page.ok) {
            repoProblems.push(`${entry.owner}/${entry.repo}: ${page.failure.code}`)
            continue
          }
          for (const item of page.value.items) extra.push({ ...item, fromConfig: true })
        }
        if (repoProblems.length > 0) options.log?.(`health community:issue:gitcode:repos state=degraded message="${repoProblems.join('; ')}"`)
        const seen = new Set(mine.value.items.map((item) => `${item.owner}/${item.repo}/${String(item.number)}`))
        const combined = [...mine.value.items, ...extra.filter((item) => !seen.has(`${item.owner}/${item.repo}/${String(item.number)}`))]
        return { ok: true, value: { items: combined, totalCount: mine.value.items.length, lastPage: mine.value.lastPage } }
      },
      async detail(ref: IssueRef, _etag: string | undefined): Promise<PollResult<IssueDetail | 'unchanged'>> {
        // api/v5 sends no validator for issue details (measured 18:24Z), so the
        // ETag argument is accepted only to satisfy the shared contract.
        return reader.detail(ref.owner, ref.repo, ref.number)
      },
      async lastComment(ref: IssueRef, count: number): Promise<PollResult<LastComment>> {
        return reader.lastComment(ref.owner, ref.repo, ref.number, count)
      },
    }
    if ((gitcodeIdentity?.state ?? 'down') === 'down') {
      // Identity refused (token present but rejected) still names the header slot.
      unavailable.gitcode = `${gitcodeIdentity?.message ?? 'GitCode identity unavailable'}; api/v5 /user/issues answers 400 when the private-token header is missing`
    }
  }

  return {
    sources,
    unavailable,
    githubListReads: () => listReads,
    gitcodeRepos: () => repoEntries.length,
  }
}
