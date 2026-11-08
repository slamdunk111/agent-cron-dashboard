/**
 * Neutral vocabulary of the issue poller (P3).
 *
 * Kept free of storage and transport types so both the GitHub reader and the
 * GitCode reader (`issue-watch-github.ts`, `issue-watch-gitcode.ts`) can depend
 * on it without importing each other, and the scheduler (`issue-watch.ts`)
 * can decide everything from these values alone.
 */
import type { Platform } from './identity.ts'

/** Which stage of the pipeline a log line belongs to. */
export type IssueStage = 'list' | 'detail' | 'comments'

/** One issue as the orchestrator addresses it. */
export interface IssueRef {
  /** Non-null: an undefined platform would make every `round#` line unusable. */
  readonly platform: NonNullable<Platform>
  readonly owner: string
  readonly repo: string
  readonly number: number
}

/** One discovered issue from a list read. */
export interface ListedIssue extends IssueRef {
  /** Whether the list read has a usable `updated_at` (it keeps the earliest tuple wins). */
  readonly updatedAt: string
  /** Whether the subject belongs to `watch.repos[]` (GitCode optional coverage). */
  readonly fromConfig: boolean
}

/** Last comment of an issue, when the host can tell it cheaply. */
export interface LastComment {
  readonly by: string | null
  readonly at: string | null
}

/** One issue as a poll observed it; every field maps to `IssueSnapshot`. */
export interface IssueDetail {
  readonly title: string
  readonly state: 'open' | 'closed'
  readonly labels: readonly string[]
  readonly assignees: readonly string[]
  readonly comments: number
  readonly updatedAt: string
  /** Present when a cheap call answered it; absent means "unknown", not "none". */
  readonly lastComment?: LastComment
  /** Optional HTTP validator of the detail answer (GitHub only). */
  readonly etag?: string
}

/** Why one poll step produced nothing. */
export interface IssueFailure {
  readonly code: 'not-found' | 'unauthenticated' | 'rate-limited' | 'unavailable'
  readonly message: string
  /** Milliseconds the host asked us to wait (`Retry-After`), when it said. */
  readonly retryAfterMs?: number
}

/** Answer of one poll step: either a value or a named failure. */
export type PollResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: IssueFailure }

/** Answer of one successful list read. */
export interface IssueListAnswer {
  readonly items: readonly ListedIssue[]
  /** `total_count` from the search answer (GitHub); undefined for repository reads. */
  readonly totalCount?: number
  /** Pages the list said exist (`Link rel=last`), when the host says. */
  readonly lastPage?: number
}

/** The polling surface one platform provides (readers implement it). */
export interface IssuePlatformSource {
  /** Discover authored issues (one page when the host pages a search). */
  list(): Promise<PollResult<IssueListAnswer>>
  /** Read one issue, conditionally when an HTTP validator is available. */
  detail(ref: IssueRef, etag: string | undefined): Promise<PollResult<IssueDetail | 'unchanged'>>
  /** Last comment when `count > 0`. */
  lastComment(ref: IssueRef, count: number): Promise<PollResult<LastComment>>
}
