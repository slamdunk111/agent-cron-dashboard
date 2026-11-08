/**
 * Frozen forge provider contract (projection of
 * `@deepseek-ai/dsh-experimental-forge` types).
 *
 * GENERATED COPY: the source of truth is `contracts/forge-provider.ts` in the
 * release repository; `pnpm sync:contracts` copies it into the package so the
 * published bundle is self-contained (ADR P0-4).
 */
/** One repository on a code host, identified the way its provider addresses it. */
export interface ForgeRepository {
  /** Forge family that serves the repository, such as `gitcode`. */
  readonly forge: string
  /** Lowercase host name, such as `gitcode.com`. */
  readonly host: string
  readonly owner: string
  readonly name: string
}

/** One change request (pull request or merge request) in a repository. */
export interface ChangeRequestRef {
  readonly repository: ForgeRepository
  readonly number: number
}

/** Lifecycle state of a change request. */
export type ChangeRequestState = 'open' | 'closed' | 'merged'

/** Normalized outcome of one status check. */
export type CheckState = 'pending' | 'success' | 'failure' | 'neutral' | 'skipped' | 'cancelled'

/** One status check reported for the head commit of a change request. */
export interface ChangeRequestCheck {
  readonly name: string
  readonly state: CheckState
  readonly url: string | null
  readonly workflow: string | null
  readonly startedAt: string | null
  readonly completedAt: string | null
}

/** Combined outcome of all checks on the head commit. */
export type ChecksRollup = 'none' | 'pending' | 'success' | 'failure'

/** Whether the change request can merge into its base without conflicts. */
export type Mergeability = 'mergeable' | 'conflicting' | 'unknown'

/** Aggregate review outcome required by the host's merge rules. */
export type ReviewDecision = 'approved' | 'changes-requested' | 'review-required' | 'none'

/** How a merge brings commits into its base branch. */
export type MergeMethod = 'merge' | 'squash' | 'rebase'

/** Status of one change request at the time its provider read it (polling preview subset). */
export interface ChangeRequestSnapshot {
  readonly ref: ChangeRequestRef
  readonly url: string
  readonly title: string
  readonly state: ChangeRequestState
  readonly draft: boolean
  readonly author: string | null
  readonly headBranch: string
  readonly headSha: string
  readonly baseBranch: string
  readonly additions: number
  readonly deletions: number
  readonly mergeability: Mergeability
  readonly mergeReady: boolean
  readonly mergeMethods: readonly MergeMethod[]
  readonly reviewDecision: ReviewDecision
  readonly checks: readonly ChangeRequestCheck[]
  readonly checksRollup: ChecksRollup
  readonly checksTruncated: boolean
  readonly unresolvedThreads: number
  readonly updatedAt: string
  readonly closedAt: string | null
}

/** Why a provider could not read a change request. */
export interface ForgeFailure {
  readonly code: 'not-found' | 'unauthenticated' | 'too-large' | 'unavailable'
  readonly message: string
}

/** Whether a provider can reach one host with the current credentials. */
export interface ForgeReadiness {
  readonly state: 'ready' | 'unauthenticated' | 'unavailable'
  readonly message: string | null
}

/** Provider capability table entry; `implemented` is false when the provider declares non-support. */
export interface ProviderCapability {
  readonly capability: ProviderCapabilityName
  readonly implemented: boolean
  /** Reason recorded in the GitCode v5 difference table when not implemented. */
  readonly note: string | null
}

/** Capability names mirroring the upstream `ForgeProvider` methods. */
export type ProviderCapabilityName =
  | 'repositoryFromRemote'
  | 'changeRequestFromUrl'
  | 'changeRequestUrl'
  | 'fetch'
  | 'fetchChecks'
  | 'findByHead'
  | 'readiness'
  | 'markReady'
  | 'merge'
  | 'diff'
  | 'fileText'
  | 'fileUrl'
  | 'submitReview'

/**
 * The subset of `ForgeProvider` the workbench consumes. `P1` implements it
 * against GitCode api/v5; optional methods left undefined mean "unsupported"
 * and forge degrades gracefully (documented upstream behaviour).
 */
export interface ForgeProviderContract {
  readonly forge: string
  repositoryFromRemote(url: string): ForgeRepository | undefined
  changeRequestFromUrl(url: string): ChangeRequestRef | undefined
  changeRequestUrl(ref: ChangeRequestRef): string
  fetch(
    refs: readonly ChangeRequestRef[],
    signal: AbortSignal,
  ): Promise<ReadonlyMap<string, ChangeRequestSnapshot | ForgeFailure>>
  findByHead(repository: ForgeRepository, branch: string, signal: AbortSignal): Promise<readonly ChangeRequestRef[]>
  readiness(host: string, signal: AbortSignal): Promise<ForgeReadiness>
  /** Declared capability table; P1 fills it from the measured v5 endpoints. */
  capabilities(): readonly ProviderCapability[]
}
