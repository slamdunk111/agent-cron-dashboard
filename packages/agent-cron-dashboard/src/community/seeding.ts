/**
 * PR seeding for the community watch (P2, plan §3.2 / §5.1).
 *
 * Turns "my open pull requests in the repositories I watch" into the watch
 * set. Both platforms read the same shape (`state=open`, `per_page=50`,
 * author filter) so the oracle script (a separate implementation) and this
 * module agree on the expected set; page rules are fixed and identical:
 * GitHub reads page 1 only and reports `degraded` when `Link rel=last` says
 * more, GitCode reads 1..3 pages and stops at the first short page.
 */
import type { IdentityConfig } from '../config-validate.ts'
import type { PlatformIdentity } from './identity.ts'
import { effectiveLogin, tokenOf } from './identity.ts'

/** Page size every list read uses (measurable; plan §5.5). */
export const LIST_PER_PAGE = 50
/** GitCode page ceiling: a full third page means the rest is not listed. */
export const GITCODE_MAX_PAGES = 3

/** One discovered change request. */
export interface SeededPr {
  readonly platform: 'github' | 'gitcode'
  readonly owner: string
  readonly repo: string
  readonly number: number
  /** `seed:<platform>` for the main list, `github:fork:<owner>` for fork-originated requests. */
  readonly sourceId: string
  readonly state: 'open' | 'closed' | 'merged'
  readonly updatedAt: string
}

/** Health of one platform's seeding pass (`community:seed:<platform>`). */
export interface SeedHealth {
  readonly sourceId: `community:seed:${'github' | 'gitcode'}`
  readonly state: 'up' | 'degraded' | 'down'
  readonly message: string | null
  readonly checkedAt: string
}

/** Result of one seeding pass. */
export interface SeedOutcome {
  readonly seeded: readonly SeededPr[]
  readonly health: readonly SeedHealth[]
  readonly at: string
}

/** One HTTP GET result (the `link` header drives GitHub page detection). */
export interface SeedTransport {
  get(url: string, headers: Readonly<Record<string, string>>): Promise<{ status: number; text: string; link?: string | null }>
}

/** Options of {@link seedPullRequests}. */
export interface SeedOptions {
  /** `watch.repos[]` entries. */
  readonly repos: readonly string[]
  /** Resolved identities (GitHub may be `down`; GitCode carries `tokenEnv`). */
  readonly identities: readonly PlatformIdentity[]
  readonly identitiesConfig?: readonly IdentityConfig[]
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly transport?: SeedTransport
  readonly now?: () => Date
  readonly log?: (line: string) => void
}

const REPO_RE = /^(?:https?:\/\/)?(github\.com|gitcode\.com)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\.git)?\/?$/

/** Split a configured repository URL into host/owner/name. */
export function parseRepo(url: string): { host: string; owner: string; name: string } | undefined {
  const match = REPO_RE.exec(url.trim())
  if (match === null) return undefined
  return { host: match[1], owner: match[2], name: match[3] }
}

/** Extract the `rel="last"` page number from a GitHub Link header. */
export function lastPageOf(link: string | null | undefined): number | undefined {
  if (typeof link !== 'string') return undefined
  const match = /<[^>]*?page=(\d+)[^>]*>;\s*rel="last"/.exec(link)
  return match === null ? undefined : Number(match[1])
}

interface PullJson {
  readonly number?: number
  readonly state?: string
  readonly merged_at?: string
  readonly updated_at?: string
  readonly user?: { login?: string }
  readonly head?: { repo?: { owner?: { login?: string } } | null }
}

/** Same state rule on both platforms; `""` is not a merge (P1 diff table §49). */
function stateOf(pull: PullJson): SeededPr['state'] {
  if (typeof pull.merged_at === 'string' && pull.merged_at.length > 0) return 'merged'
  if (pull.state === 'merged') return 'merged'
  return pull.state === 'open' ? 'open' : 'closed'
}

/** Default transport: plain GET with a deadline. */
export function defaultSeedTransport(): SeedTransport {
  return {
    async get(url, headers) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 20_000)
      if (timer.unref !== undefined) timer.unref()
      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: { ...headers, 'User-Agent': 'agent-cron-dashboard' },
          signal: controller.signal,
          redirect: 'manual',
        })
        return { status: response.status, text: await response.text(), link: response.headers.get('link') }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/**
 * Run one seeding pass.
 * @param options - repository list, identities and injectable transport.
 * @returns discovery results plus one health row per platform.
 */
export async function seedPullRequests(options: SeedOptions): Promise<SeedOutcome> {
  const now = options.now ?? (() => new Date())
  const transport = options.transport ?? defaultSeedTransport()
  const log = options.log ?? ((line: string) => console.log(line))
  const at = now().toISOString()
  const parsed = options.repos.map((url) => ({ url, repo: parseRepo(url) }))
  const unparsable = parsed.filter((entry) => entry.repo === undefined).map((entry) => entry.url)
  const githubRepos = parsed.flatMap((entry) => (entry.repo !== undefined && entry.repo.host === 'github.com' ? [entry.repo] : []))
  const gitcodeRepos = parsed.flatMap((entry) => (entry.repo !== undefined && entry.repo.host === 'gitcode.com' ? [entry.repo] : []))
  const note = unparsable.length === 0 ? [] : [`unparsable watch.repos[] entries: ${unparsable.join(', ')}`]

  const github = options.identities.find((identity) => identity.platform === 'github')
  const gitcode = options.identities.find((identity) => identity.platform === 'gitcode')
  // One rule for both consumers of the author filter (plan §3.1 rule 4).
  const githubLogin = effectiveLogin(options.identities, 'github')
  const gitcodeLogin = effectiveLogin(options.identities, 'gitcode')
  const seeded: SeededPr[] = []

  // ---- GitHub ----------------------------------------------------------------
  const githubHealth: SeedHealth = { sourceId: 'community:seed:github', state: 'up', message: null, checkedAt: at }
  const githubProblems: string[] = []
  if (githubRepos.length === 0) {
    githubProblems.push('no github.com repository in watch.repos[]; nothing to seed')
  }
  if (githubLogin === undefined) {
    githubProblems.push(`GitHub identity unavailable (${github?.message ?? 'no identity'})`)
  }
  for (const repo of githubLogin !== undefined ? githubRepos : []) {
    const url = `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls?state=open&per_page=${LIST_PER_PAGE}&page=1`
    let result: { status: number; text: string; link?: string | null }
    try {
      result = await transport.get(url, { Accept: 'application/vnd.github+json' })
    } catch (error) {
      githubProblems.push(`${repo.owner}/${repo.name}: request failed (${error instanceof Error ? error.message : String(error)})`)
      continue
    }
    if (result.status !== 200) {
      githubProblems.push(`${repo.owner}/${repo.name}: HTTP ${result.status}`)
      continue
    }
    const body = jsonOf(result.text)
    if (!Array.isArray(body)) {
      githubProblems.push(`${repo.owner}/${repo.name}: response is not a JSON list`)
      continue
    }
    const last = lastPageOf(result.link)
    if (last !== undefined && last > 1) {
      // Fixed page rule: GitHub reads page 1 only; a further page is named so
      // G1 fails instead of silently under-reporting.
      githubProblems.push(`${repo.owner}/${repo.name}: ${last} pages of open pull requests, only page 1 read`)
    }
    for (const pull of body as PullJson[]) {
      if (typeof pull.number !== 'number') continue
      if (pull.user?.login !== githubLogin) continue
      const headOwner = pull.head?.repo?.owner?.login
      seeded.push({
        platform: 'github',
        owner: repo.owner,
        repo: repo.name,
        number: pull.number,
        sourceId: headOwner !== undefined && headOwner !== repo.owner ? `github:fork:${headOwner}` : 'seed:github',
        state: stateOf(pull),
        updatedAt: pull.updated_at ?? '',
      })
    }
  }
  const githubFailures = githubProblems.filter((entry) => !entry.startsWith('no github.com repository'))
  const githubState: SeedHealth['state'] =
    githubProblems.length === 0
      ? 'up'
      : githubLogin === undefined
        ? 'down'
        : githubFailures.some((entry) => /HTTP|failed|not a JSON list/.test(entry))
          ? 'degraded'
          : 'degraded'

  // ---- GitCode ---------------------------------------------------------------
  const gitcodeHealth: SeedHealth = { sourceId: 'community:seed:gitcode', state: 'up', message: null, checkedAt: at }
  const gitcodeProblems: string[] = []
  const identityConfig = options.identitiesConfig?.find((entry) => entry.platform === 'gitcode')
  const token = identityConfig === undefined ? undefined : tokenOf(options.env ?? {}, identityConfig.tokenEnv)
  if (gitcodeRepos.length === 0) {
    gitcodeProblems.push('no gitcode.com repository in watch.repos[]; nothing to seed')
  }
  if (gitcodeLogin === undefined) {
    // D8: no token means the platform is skipped (never watched repository-wide).
    gitcodeProblems.push(`GitCode seeding skipped (${gitcode?.message ?? 'identity not up'})`)
  } else if (token === undefined) {
    gitcodeProblems.push('GitCode seeding skipped (no token in the configured tokenEnv)')
  }
  const listToken: string | undefined = identityConfig === undefined ? undefined : tokenOf(options.env ?? {}, identityConfig.tokenEnv)
  const usableToken: string = listToken ?? ''
  const listRepos = gitcodeLogin !== undefined && listToken !== undefined ? gitcodeRepos : []
  for (const repo of listRepos) {
    let stop = false
    let listed = 0
    for (let page = 1; page <= GITCODE_MAX_PAGES && !stop; page += 1) {
      const url = `https://gitcode.com/api/v5/repos/${repo.owner}/${repo.name}/pulls?state=open&per_page=${LIST_PER_PAGE}&page=${page}`
      let result: { status: number; text: string }
      try {
        result = await transport.get(url, { Accept: 'application/json', 'private-token': usableToken })
      } catch (error) {
        gitcodeProblems.push(`${repo.owner}/${repo.name}: page ${page} failed (${error instanceof Error ? error.message : String(error)})`)
        stop = true
        break
      }
      if (result.status !== 200) {
        gitcodeProblems.push(`${repo.owner}/${repo.name}: page ${page} HTTP ${result.status}`)
        stop = true
        break
      }
      const body = jsonOf(result.text)
      if (!Array.isArray(body)) {
        gitcodeProblems.push(`${repo.owner}/${repo.name}: page ${page} is not a JSON list`)
        stop = true
        break
      }
      const rows = body as PullJson[]
      listed += rows.length
      for (const pull of rows) {
        if (typeof pull.number !== 'number') continue
        if (pull.user?.login !== gitcodeLogin) continue
        // `state=open` already filters server-side; the guard below keeps a stale
        // cache from smuggling a merged row in ("" is not a merge, §49).
        if (pull.state !== 'open') continue
        if (typeof pull.merged_at === 'string' && pull.merged_at.length > 0) continue
        seeded.push({
          platform: 'gitcode',
          owner: repo.owner,
          repo: repo.name,
          number: pull.number,
          sourceId: 'seed:gitcode',
          state: stateOf(pull),
          updatedAt: pull.updated_at ?? '',
        })
      }
      if (rows.length < LIST_PER_PAGE) stop = true
      if (page === GITCODE_MAX_PAGES && !stop) {
        gitcodeProblems.push(`${repo.owner}/${repo.name}: ${GITCODE_MAX_PAGES} full pages read (${listed} items); older requests were not listed`)
      }
    }
  }
  // Any note (skip, truncation, page failure) is a named degradation; only a
  // total failure without a single item is `down`.
  // A platform that was skipped outright (identity down) is `down`, not `degraded`.
  const skipped = gitcodeProblems.some((entry) => /skipped/.test(entry))
  const gitcodeState: SeedHealth['state'] = gitcodeProblems.length === 0 ? 'up' : skipped ? 'down' : 'degraded'

  const health: SeedHealth[] = [
    { ...githubHealth, state: githubState, message: githubProblems.length === 0 ? null : [...githubProblems, ...note].join('; ') },
    { ...gitcodeHealth, state: gitcodeState, message: gitcodeProblems.length === 0 ? null : [...gitcodeProblems, ...note].join('; ') },
  ]
  for (const row of health) {
    log(`health ${row.sourceId} state=${row.state} message="${row.message ?? ''}"`)
  }
  return { seeded: dedupe([...seeded]), health, at }
}

/** Merge duplicate discoveries by key, keeping the newest `updatedAt`. */
export function dedupe(items: readonly SeededPr[]): SeededPr[] {
  const seen = new Map<string, SeededPr>()
  for (const item of items) {
    const key = `${item.platform}/${item.owner}/${item.repo}/${item.number}`
    const current = seen.get(key)
    if (current === undefined || item.updatedAt > current.updatedAt) seen.set(key, item)
  }
  return [...seen.values()]
}

/** Storage key of one change request (`<platform>/<owner>/<repo>/<number>`). */
export function seededKey(item: SeededPr): string {
  return `${item.platform}/${item.owner}/${item.repo}/${item.number}`
}

/** Cursor token of one seeding pass (no credentials). */
export function seedCursorToken(items: readonly SeededPr[], at: string): string {
  return JSON.stringify({ at, count: items.length, keys: items.map(seededKey) })
}
