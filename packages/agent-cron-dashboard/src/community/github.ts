/**
 * GitHub reader for the community watch (P2, plan §3.6 / D4).
 *
 * The dev profile carries only the GitCode provider, so GitHub change
 * requests are read here with `gh api` and mapped onto the frozen
 * `ChangeRequestSnapshot` shape. This reader is **not** registered with
 * `ctx.forge` (plan D4): registering a `github` family would collide with
 * `dsh-experimental-forge-github` once P8 installs it, and the registry's
 * polling contract is covered by this adapter's own 60 s loop.
 *
 * Every value that reaches `checksRollup` comes from the measured pairs
 * (2026-11-08T13:32:58 / 13:33:25): a status list with `total_count === 0`
 * reports `state: 'pending'`, which means "no status" rather than "running".
 */
import type { ChangeRequestCheck, ChangeRequestSnapshot, ChecksRollup, ForgeFailure, Mergeability, ReviewDecision } from './contract-types.ts'

/** One change request as the watch service addresses it. */
export interface GithubRef {
  readonly owner: string
  readonly repo: string
  readonly number: number
}

/** Result of one adapter poll, mirroring the forge `ChangeRequestUpdate` fields P2 consumes. */
export interface GithubUpdate {
  readonly key: string
  readonly fetchedAt: number
  readonly snapshot?: ChangeRequestSnapshot
  readonly failure?: ForgeFailure
}

/** Minimal local redaction for the default sink (callers may inject a stricter one). */
function redactLine(line: string): string {
  return line
}

/** Storage key used by `PrSnapshot` (`<platform>/<owner>/<repo>/<number>`). */
export function githubKey(ref: GithubRef): string {
  return `github/${ref.owner}/${ref.repo}/${ref.number}`
}

/** Runs one `gh api` call and resolves to stdout. */
export type GhApiRunner = (path: string) => Promise<string>

/** Adapter options. */
export interface GithubProviderOptions {
  readonly runner?: GhApiRunner
  /** Poll period; the plan's measurement uses 60 s. */
  readonly intervalMs?: number
  readonly now?: () => Date
  readonly log?: (line: string) => void
}

/** Rows the adapter reads from GitHub's REST answers (only the fields it uses). */
export interface GithubPullJson {
  readonly number?: number
  readonly title?: string
  readonly state?: string
  readonly draft?: boolean
  readonly merged_at?: string | null
  readonly updated_at?: string
  readonly html_url?: string
  readonly mergeable?: boolean | null
  readonly mergeable_state?: string | null
  readonly additions?: number
  readonly deletions?: number
  readonly user?: { login?: string }
  readonly head?: { ref?: string; sha?: string }
  readonly base?: { ref?: string }
}

export interface GithubReviewsJson {
  readonly user?: { login?: string }
  readonly state?: string
  readonly submitted_at?: string
}

export interface GithubStatusJson {
  readonly state?: string
  readonly total_count?: number
  readonly statuses?: ReadonlyArray<{ readonly context?: string; readonly state?: string }>
}

export interface GithubCheckRunsJson {
  readonly total_count?: number
  readonly check_runs?: ReadonlyArray<{
    readonly name?: string
    readonly status?: string
    readonly conclusion?: string | null
    readonly html_url?: string
  }>
}

/** Failure/unfinished/plain-success sets (plan §3.6, values kept verbatim). */
const FAILURE_CONCLUSIONS = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'stale', 'startup_failure'])
const UNFINISHED = new Set(['pending', 'in_progress', 'queued', 'requested', 'waiting'])
const SUCCESS_CONCLUSIONS = new Set(['success', 'skipped', 'neutral'])

/** Map `mergeable`/`mergeable_state` to the contract's three values. */
export function mergeabilityOf(pull: GithubPullJson): Mergeability {
  if (pull.mergeable === false || pull.mergeable_state === 'dirty') return 'conflicting'
  if (pull.mergeable === true && pull.mergeable_state === 'clean') return 'mergeable'
  return 'unknown'
}

/**
 * Fold the status list and the check-runs list into one rollup.
 *
 * Measured empty case: `total_count = 0` with `state: 'pending'`, so emptiness
 * is decided by the counts, never by the state string.
 * @returns the rollup plus the conclusion that made it `failure` (if unknown).
 */
export function rollupOf(status: GithubStatusJson | undefined, checks: GithubCheckRunsJson | undefined): {
  rollup: ChecksRollup
  unknown?: string
} {
  const statusRows = status?.statuses ?? []
  const checkRows = checks?.check_runs ?? []
  const statusCount = (status?.total_count ?? statusRows.length)
  const checkCount = (checks?.total_count ?? checkRows.length)
  if (statusCount === 0 && checkCount === 0) return { rollup: 'none' }
  for (const row of statusRows) {
    const state = row.state ?? ''
    if (state === 'failure' || state === 'error') return { rollup: 'failure' }
  }
  for (const row of checkRows) {
    const conclusion = row.conclusion
    if (conclusion !== null && conclusion !== undefined && FAILURE_CONCLUSIONS.has(conclusion)) return { rollup: 'failure' }
    if (conclusion !== null && conclusion !== undefined && !SUCCESS_CONCLUSIONS.has(conclusion) && !UNFINISHED.has(conclusion)) {
      // Fail closed: a conclusion outside every known set is not a pass.
      return { rollup: 'failure', unknown: conclusion }
    }
  }
  const statusPending = statusRows.some((row) => row.state === 'pending' || row.state === 'error')
  if (statusPending || status?.state === 'pending' && statusRows.length > 0) return { rollup: 'pending' }
  for (const row of checkRows) {
    if (row.conclusion === null || row.conclusion === undefined) return { rollup: 'pending' }
    if (UNFINISHED.has(row.conclusion)) return { rollup: 'pending' }
  }
  for (const row of statusRows) {
    if (row.state !== undefined && !['success', 'failure', 'error', 'pending'].includes(row.state)) {
      return { rollup: 'failure', unknown: row.state }
    }
  }
  return { rollup: 'success' }
}

/** Latest review per user decides that user's verdict; any change request wins. */
export function reviewDecisionOf(reviews: readonly GithubReviewsJson[] | undefined): ReviewDecision {
  if (reviews === undefined) return 'none'
  const latest = new Map<string, { state: string; at: string }>()
  for (const review of reviews) {
    const login = review.user?.login ?? ''
    const state = review.state ?? ''
    const at = review.submitted_at ?? ''
    const current = latest.get(login)
    if (current === undefined || current.at < at) latest.set(login, { state, at })
  }
  const states = [...latest.values()].map((entry) => entry.state)
  if (states.includes('CHANGES_REQUESTED')) return 'changes-requested'
  if (states.includes('APPROVED')) return 'approved'
  return reviews.length > 0 ? 'review-required' : 'none'
}

/** Build the frozen snapshot shape from the three REST answers. */
export function snapshotOf(
  ref: GithubRef,
  pull: GithubPullJson,
  status: GithubStatusJson | undefined,
  checks: GithubCheckRunsJson | undefined,
  reviews: readonly GithubReviewsJson[] | undefined,
): { snapshot: ChangeRequestSnapshot; unknownConclusion?: string } {
  const composed = rollupOf(status, checks)
  const state = typeof pull.merged_at === 'string' && pull.merged_at.length > 0 ? 'merged' : pull.state === 'open' ? 'open' : 'closed'
  const checkRows = checks?.check_runs ?? []
  const checksList: ChangeRequestCheck[] =
    composed.rollup === 'none'
      ? []
      : [
          {
            name: `github checks (${checkRows.length + (status?.statuses ?? []).length})`,
            state: composed.rollup === 'failure' ? 'failure' : composed.rollup === 'pending' ? 'pending' : 'success',
            url: checkRows[0]?.html_url ?? null,
            workflow: null,
            startedAt: null,
            completedAt: null,
          },
        ]
  return {
    unknownConclusion: composed.unknown,
    snapshot: {
      ref: { repository: { forge: 'github', host: 'github.com', owner: ref.owner, name: ref.repo }, number: ref.number },
      url: pull.html_url ?? `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`,
      title: pull.title ?? '',
      state,
      draft: pull.draft === true,
      author: pull.user?.login ?? null,
      headBranch: pull.head?.ref ?? '',
      headSha: pull.head?.sha ?? '',
      baseBranch: pull.base?.ref ?? '',
      additions: pull.additions ?? 0,
      deletions: pull.deletions ?? 0,
      mergeability: mergeabilityOf(pull),
      mergeReady: state === 'open' && pull.draft !== true && pull.mergeable === true && pull.mergeable_state === 'clean',
      mergeMethods: ['merge', 'squash', 'rebase'],
      reviewDecision: reviewDecisionOf(reviews),
      checks: checksList,
      checksRollup: composed.rollup,
      checksTruncated: false,
      // GitHub exposes review threads only through GraphQL, which this batch does
      // not read: the number is unknown, recorded as 0 by contract (P1 note).
      unresolvedThreads: 0,
      updatedAt: pull.updated_at ?? '',
      closedAt: state === 'open' ? null : (typeof pull.merged_at === 'string' && pull.merged_at.length > 0 ? pull.merged_at : null),
    },
  }
}

/** Default runner: `gh api <path>`. */
export function spawnGhApi(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    void (async () => {
      const { spawn } = await import('node:child_process')
      const child = spawn('gh', ['api', path], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 })
      let out = ''
      let err = ''
      child.stdout?.on('data', (chunk: Buffer) => {
        out += chunk.toString('utf8')
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        err += chunk.toString('utf8')
      })
      child.on('error', reject)
      child.on('close', (code) => {
        if (code === 0) resolvePromise(out.trim())
        else reject(new Error(err.trim() || `gh exited ${String(code)}`))
      })
    })()
  })
}

/** Map a thrown runner error (its message starts with `HTTP <status>`) to a forge failure. */
function failureOf(error: unknown): ForgeFailure {
  const message = error instanceof Error ? error.message : String(error)
  const status = Number((/HTTP (\d{3})/.exec(message) ?? [])[1] ?? 0)
  if (status === 401 || status === 403) return { code: 'unauthenticated', message }
  if (status === 404) return { code: 'not-found', message }
  if (/timed out|ETIMEDOUT|timeout/i.test(message)) return { code: 'unavailable', message: `timeout: ${message}` }
  return { code: 'unavailable', message }
}

/** One read of a change request, exposed for tests and for the smoke script. */
export async function fetchGithub(ref: GithubRef, runner: GhApiRunner): Promise<{ snapshot: ChangeRequestSnapshot; unknownConclusion?: string } | ForgeFailure> {
  let pullText: string
  try {
    pullText = await runner(`repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`)
  } catch (error) {
    return failureOf(error)
  }
  let pull: GithubPullJson
  try {
    pull = JSON.parse(pullText) as GithubPullJson
  } catch {
    return { code: 'unavailable', message: 'pull payload is not JSON' }
  }
  const sha = pull.head?.sha ?? ''
  const [status, checks, reviews] = await Promise.all([
    runner(`repos/${ref.owner}/${ref.repo}/commits/${sha}/status`).then(
      (text) => JSON.parse(text) as GithubStatusJson,
      () => undefined,
    ),
    runner(`repos/${ref.owner}/${ref.repo}/commits/${sha}/check-runs`).then(
      (text) => JSON.parse(text) as GithubCheckRunsJson,
      () => undefined,
    ),
    runner(`repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/reviews`).then(
      (text) => JSON.parse(text) as GithubReviewsJson[],
      () => undefined,
    ),
  ])
  return snapshotOf(ref, pull, status, checks, reviews)
}

/**
 * GitHub side of the watch: one 60 s loop per change request (plan §3.6),
 * with exponential backoff capped at 600 s and a stop after `merged`.
 */
export class GithubProvider {
  /** Concurrency ceiling: at most this many `gh` calls in flight. */
  static readonly CONCURRENCY = 4
  /** Plan §3.6 quota ceiling: at most this many change requests watched at once. */
  static readonly MAX_WATCHED = 10
  private readonly runner: GhApiRunner
  private readonly intervalMs: number
  private readonly now: () => Date
  private readonly log: (line: string) => void
  private readonly watches = new Map<string, { stopped: boolean }>()
  private readonly failures = new Map<string, number>()
  /** In-flight `gh` calls; the adapter never runs more than CONCURRENCY at once. */
  private readonly slots: Array<() => void> = []
  private active = 0

  constructor(options: GithubProviderOptions = {}) {
    this.runner = options.runner ?? spawnGhApi
    this.intervalMs = options.intervalMs ?? 60_000
    this.now = options.now ?? (() => new Date())
    // Callers inject a redacting sink; the module never prints credentials itself.
    this.log = options.log ?? ((line: string) => console.log(redactLine(line)))
  }

  /** Run `task` while holding one of the CONCURRENCY slots. */
  async withSlot<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= GithubProvider.CONCURRENCY) await new Promise<void>((resolvePromise) => this.slots.push(resolvePromise))
    this.active += 1
    try {
      return await task()
    } finally {
      this.active -= 1
      const next = this.slots.shift()
      if (next !== undefined) next()
    }
  }

  /** How many change requests have an active loop. */
  get watched(): number {
    return this.watches.size
  }

  /**
   * Start polling one change request.
   * @returns disposer that stops the loop and clears its backoff state.
   */
  subscribe(ref: GithubRef, listener: (update: GithubUpdate) => void): () => void {
    const key = githubKey(ref)
    if (this.watches.size >= GithubProvider.MAX_WATCHED && !this.watches.has(key)) {
      // Quota ceiling (plan §3.6): refuse to add more and say why.
      this.log(`health community:github state=degraded message="GitHub quota limit, not watching ${ref.owner}/${ref.repo}#${ref.number}"`)
      return () => {}
    }
    const handle = { stopped: false }
    this.watches.set(key, handle)
    const poll = async (): Promise<void> => {
      if (handle.stopped) return
      const result = await this.withSlot(() => fetchGithub(ref, this.runner))
      if (handle.stopped) return
      const fetchedAt = this.now().getTime()
      if ('code' in result) {
        const count = (this.failures.get(key) ?? 0) + 1
        this.failures.set(key, count)
        listener({ key, fetchedAt, failure: result })
      } else {
        this.failures.delete(key)
        if (result.unknownConclusion !== undefined) {
          this.log(`health community:github:pr:${ref.owner}/${ref.repo}/${ref.number} state=degraded message="unknown-conclusion:${result.unknownConclusion}"`)
        }
        listener({ key, fetchedAt, snapshot: result.snapshot })
        if (result.snapshot.state === 'merged') {
          handle.stopped = true
          this.watches.delete(key)
          return
        }
      }
      if (handle.stopped) return
      const backoff = Math.min(600_000, this.intervalMs * 2 ** Math.min(4, this.failures.get(key) ?? 0))
      const timer = setTimeout(() => void poll(), backoff)
      if (timer.unref !== undefined) timer.unref()
    }
    void poll()
    return () => {
      handle.stopped = true
      this.watches.delete(key)
      this.failures.delete(key)
    }
  }
}
