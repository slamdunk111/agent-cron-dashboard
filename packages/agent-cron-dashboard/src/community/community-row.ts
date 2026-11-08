/**
 * Community row (P3): the issue poller bound to the workbench storage tables.
 *
 * Split out of `index.ts` so the scheduler fact is readable in one place:
 * `ctx.get('storageDomain')` opens `workbench_snapshot_issue` and
 * `workbench_cursors`, the row starts **one** `setInterval` at
 * `watch.issuePollIntervalMs` (default 5 min, plan §4), and the disposer clears
 * it. The token is read only here, only through `tokenOf(env, tokenEnv)`, and
 * only when the row was started with `withIssues` (P2 R-round rule: no
 * credential read for rows that do not poll).
 */
import type { SnapshotPair } from '../../../../contracts/events.ts'
import type { IssueSnapshot } from '../../../../contracts/records.ts'
import type { IdentityConfig } from '../config-validate.ts'
import { effectiveLogin, type PlatformIdentity } from './identity.ts'
import type { CursorTable, IssueTable } from './issue-watch.ts'
import { makeIssueSources, type IssueSourcesResult } from './issue-sources.ts'
import { IssueWatchService, type PlatformCursorRecord } from './issue-watch.ts'
import type { HttpGet } from './http-get.ts'

/** The two storage tables the poller writes (dsh domain handles answer both calls). */
export interface IssueTables {
  readonly issueTable: IssueTable
  readonly cursors: CursorTable
}

/** The part of a domain handle the poller uses. */
export interface DomainHandle {
  readonly snapshots?: IssueTable
  readonly cursors?: CursorTable
}

/** One round of polling, as the runner reports it. */
export interface RoundOutcome {
  readonly platform: 'github' | 'gitcode'
  readonly ok: boolean
  readonly considered: number
  readonly changed: number
  readonly queued: number
}

/** Options of {@link IssuePollRunner}. */
export interface IssuePollRunnerOptions {
  readonly service: IssueWatchService
  readonly intervalMs: number
  readonly sources: IssueSourcesResult
  readonly platforms?: readonly ('github' | 'gitcode')[]
  readonly now?: () => Date
  readonly log?: (line: string) => void
  /** Ceiling of the exponential backoff after a failed platform round. */
  readonly maxBackoffMs?: number
  /** Base of the backoff (the poll interval). */
  readonly backoffBaseMs?: number
}

/**
 * Drives one poll pass (both platforms, sequential) and schedules the next.
 *
 * Backoff: a failed platform round doubles the wait for that platform only
 * (`min(maxBackoffMs, base × 2^n)`), so a refused GitCode token cannot slow the
 * GitHub loop and vice versa (same rule as P5's "退避独立", proven here first).
 */
export class IssuePollRunner {
  private readonly options: IssuePollRunnerOptions
  private readonly log: (line: string) => void
  private readonly failures: Record<'github' | 'gitcode', number>
  private timer: ReturnType<typeof setTimeout> | undefined
  private stopped = false
  private running: Promise<RoundOutcome[]> | undefined

  constructor(options: IssuePollRunnerOptions) {
    this.options = options
    this.log = options.log ?? ((line: string) => console.log(line))
    this.failures = { github: 0, gitcode: 0 }
  }

  /** Platforms this runner drives. */
  private platforms(): readonly ('github' | 'gitcode')[] {
    return this.options.platforms ?? ['github', 'gitcode']
  }

  /**
   * Run one pass over both platforms.
   * @returns what each platform's round did.
   */
  async pollRound(): Promise<RoundOutcome[]> {
    const outcomes: RoundOutcome[] = []
    for (const platform of this.platforms()) {
      const result = await this.options.service.pollOnce(platform)
      if (result.ok) this.failures[platform] = 0
      else this.failures[platform] += 1
      outcomes.push({
        platform,
        ok: result.ok,
        considered: result.considered,
        changed: result.changed,
        queued: result.queued,
      })
    }
    return outcomes
  }

  /** Wait for the next round after a failure: `min(max, base × 2^attempt)`. */
  private backoffOf(platform: 'github' | 'gitcode'): number {
    const base = this.options.backoffBaseMs ?? this.options.intervalMs
    const max = this.options.maxBackoffMs ?? 600_000
    const attempt = Math.min(4, this.failures[platform])
    return Math.min(max, base * 2 ** attempt)
  }

  /** Start the loop; the first round runs immediately (the row wants data at mount). */
  start(): void {
    this.stopped = false
    void this.schedule()
  }

  /** Stop the loop and let an in-flight round settle. */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    if (this.running !== undefined) await this.running.catch(() => undefined)
  }

  private nextDelay(outcomes: readonly RoundOutcome[]): number {
    const failed = outcomes.filter((outcome) => !outcome.ok).map((outcome) => this.backoffOf(outcome.platform))
    return failed.length === 0 ? this.options.intervalMs : Math.max(...failed)
  }

  private async schedule(): Promise<void> {
    if (this.stopped) return
    this.running = this.pollRound()
    const outcomes = await this.running
    this.running = undefined
    if (this.stopped) return
    const delay = this.nextDelay(outcomes)
    for (const outcome of outcomes) {
      this.log(`poll platform=${outcome.platform} ok=${String(outcome.ok)} considered=${String(outcome.considered)} changed=${String(outcome.changed)} queued=${String(outcome.queued)}`)
    }
    this.log(`poll next=${String(delay)}ms`)
    this.timer = setTimeout(() => void this.schedule(), delay)
    if (this.timer.unref !== undefined) this.timer.unref()
  }

  /** Bookkeeping of one platform as stored (gate reads it). */
  cursorOf(platform: 'github' | 'gitcode'): PlatformCursorRecord {
    return this.options.service.cursorOf(platform)
  }
}

/** Options of {@link startIssueWatch}. */
export interface StartIssueWatchOptions {
  /** Row config (validated). */
  readonly config: { readonly identities: readonly IdentityConfig[]; readonly watch: { readonly repos: readonly string[]; readonly issuePollIntervalMs: number } }
  readonly env: Readonly<Record<string, string | undefined>>
  /** Resolved identities; the row resolves them once at mount (gh may be slow). */
  readonly identities: readonly PlatformIdentity[]
  readonly tables: IssueTables
  readonly transport?: HttpGet
  /** Overrides the GitHub transport only (the `gh`-credential path in the smoke). */
  readonly githubTransport?: HttpGet
  readonly now?: () => Date
  readonly log?: (line: string) => void
  /** P4 hook; absent means pairs are persisted only. */
  readonly onPair?: (pair: SnapshotPair<IssueSnapshot>) => void
  /** Start the loop (false = build only; the smoke drives rounds by hand). */
  readonly autostart?: boolean
}

/** What the row keeps for its disposer and for inspect. */
export interface IssueWatchHandle {
  readonly service: IssueWatchService
  readonly runner: IssuePollRunner
  readonly sources: IssueSourcesResult
  readonly intervalMs: number
  /** Logins the poller watches for (GitCode `down` shows the configured name). */
  readonly logins: Readonly<Record<'github' | 'gitcode', string | undefined>>
  dispose(): Promise<void>
}

/**
 * Build (and optionally start) the issue poller for one row.
 * @param options - config, identities, tables and injectable transport.
 * @returns a handle whose `dispose` stops the timer and the watches.
 */
export function startIssueWatch(options: StartIssueWatchOptions): IssueWatchHandle {
  const now = options.now ?? (() => new Date())
  const log = options.log ?? ((line: string) => console.log(line))
  const sources = makeIssueSources({
    identities: options.identities,
    identitiesConfig: options.config.identities,
    env: options.env,
    transport: options.transport,
    githubTransport: options.githubTransport,
    now,
    repos: options.config.watch.repos,
    log,
  })
  const service = new IssueWatchService({
    issueTable: options.tables.issueTable,
    cursors: options.tables.cursors,
    sources: sources.sources,
    identities: options.identities,
    unavailable: sources.unavailable,
    repos: options.config.watch.repos,
    now,
    log,
    onPair: options.onPair,
  })
  const intervalMs = options.config.watch.issuePollIntervalMs
  const runner = new IssuePollRunner({ service, intervalMs, sources, now, log })
  if (options.autostart !== false) runner.start()
  return {
    service,
    runner,
    sources,
    intervalMs,
    logins: {
      github: effectiveLogin(options.identities, 'github'),
      gitcode: effectiveLogin(options.identities, 'gitcode'),
    },
    async dispose() {
      await runner.stop()
      service.dispose()
    },
  }
}
