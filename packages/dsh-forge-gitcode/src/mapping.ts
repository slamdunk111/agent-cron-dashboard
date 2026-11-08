/**
 * Pure GitCode v5 JSON -> forge snapshot mapping.
 *
 * Field evidence (`../../docs/gitcode-v5-diff.md` §2), all from live
 * `openJiuwen/jiuwenswarm` responses captured in `fixtures/gitcode/`:
 *
 * | snapshot field  | GitCode v5 source                                        |
 * |-----------------|---------------------------------------------------------|
 * | state           | `state` is already three-valued (`open/closed/merged`)   |
 * | draft           | `draft`                                                  |
 * | mergeability    | `mergeable_state.conflict_passed === false` -> conflicting |
 * | checks rollup   | `mergeable_state.ci_state_passed` is the only CI signal; |
 * |                 | `check_tasks_num > 0` distinguishes failure from pending  |
 * | mergeReady      | every `*_passed` guard is true (host's own conjunction)   |
 * | mergeMethods    | `merge_request_switch` (`merge_method`, squash flags)     |
 * | additions/deletions | absent from the PR payload; folded in from `files`      |
 * | reviewDecision  | no reviews endpoint; approval counters only -> `none`     |
 * | unresolvedThreads | no resolve-state endpoint -> `0` (documented gap)      |
 */
import type {
  ChangeRequestCheck,
  ChangeRequestRef,
  ChangeRequestSnapshot,
  CheckState,
  ChecksRollup,
  MergeMethod,
  Mergeability,
  ReviewDecision,
} from './contracts.ts'

/** One row of `GET .../pulls` or `GET .../pulls/{n}`; only the fields this mapping reads. */
export interface GitCodePullJson {
  readonly number?: number
  readonly html_url?: string
  readonly title?: string
  readonly state?: string
  readonly draft?: boolean
  readonly testers?: readonly { readonly login?: string }[]
  readonly head?: { readonly ref?: string; readonly sha?: string; readonly label?: string }
  readonly base?: { readonly ref?: string }
  readonly user?: { readonly login?: string }
  readonly labels?: readonly { readonly name?: string }[]
  readonly updated_at?: string
  readonly created_at?: string
  readonly merged_at?: string | null
  readonly closed_at?: string | null
  readonly mergeable?: boolean
  readonly mergeable_state?: Record<string, unknown>
  readonly merge_method?: string
  readonly check_tasks_num?: number
}

/** One row of `GET .../pulls/{n}/files`. */
export interface GitCodeFileJson {
  readonly filename?: string
  readonly additions?: number
  readonly deletions?: number
}

/** A `.diff` hunk header: `@@ -a,b +c,d @@`. */
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/m

/** Count `+`/`-` body lines of a unified patch, ignoring file headers and hunks. */
export function countDiffLines(diff: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  let inHunk = false
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) {
      inHunk = HUNK.test(line)
      continue
    }
    if (!inHunk) continue
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) additions += 1
    else if (line.startsWith('-')) deletions += 1
  }
  return { additions, deletions }
}

/** Sum `files` rows; undefined rows (truncated page) fall back to the patch count. */
export function countFileLines(files: readonly GitCodeFileJson[]): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const file of files) {
    additions += typeof file.additions === 'number' ? file.additions : 0
    deletions += typeof file.deletions === 'number' ? file.deletions : 0
  }
  return { additions, deletions }
}

/** GitCode sends `""` (not null) for timestamps that do not exist. */
function filled(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function stateOf(pull: GitCodePullJson): ChangeRequestSnapshot['state'] {
  if (pull.state === 'merged' || filled(pull.merged_at) !== null) return 'merged'
  if (pull.state === 'closed' || pull.state === 'locked' || filled(pull.closed_at) !== null) return 'closed'
  return 'open'
}

function mergeabilityOf(pull: GitCodePullJson): Mergeability {
  const mergeState = pull.mergeable_state
  if (mergeState === undefined) return pull.mergeable === false ? 'conflicting' : 'unknown'
  const conflict = mergeState['conflict_passed']
  const branchMissing = mergeState['branch_missing_passed']
  if (conflict === false || branchMissing === false) return 'conflicting'
  if (mergeState['mr_state_passed'] === true) return 'mergeable'
  return 'unknown'
}

/**
 * CI outcome. GitCode publishes exactly one boolean (`ci_state_passed`) plus a
 * task counter (`check_tasks_num`), so the mapping is:
 *
 * - `true`                                 -> `success`
 * - `false` with tasks counted              -> `failure` (checks exist and the
 *   host says they do not pass; measured on open PR #9724 and merged PR #9723)
 * - `false` with no tasks                  -> `none` (no checks configured)
 * - absent                                 -> `none` (the payload hid the field)
 */
export function ciStateOf(pull: GitCodePullJson): { state: CheckState; rollup: ChecksRollup } {
  const mergeState = pull.mergeable_state
  const ci = mergeState?.['ci_state_passed']
  if (ci === true) return { state: 'success', rollup: 'success' }
  if (ci === false) {
    const tasks = typeof pull.check_tasks_num === 'number' ? pull.check_tasks_num : Number(mergeState?.['check_tasks_num'] ?? 0)
    return tasks > 0 ? { state: 'failure', rollup: 'failure' } : { state: 'skipped', rollup: 'none' }
  }
  return { state: 'pending', rollup: 'none' }
}

function checksOf(pull: GitCodePullJson, ref: ChangeRequestRef): readonly ChangeRequestCheck[] {
  const { state } = ciStateOf(pull)
  const ci = pull.mergeable_state?.['ci_state_passed']
  if (ci === undefined) return []
  const tasks = typeof pull.check_tasks_num === 'number' ? pull.check_tasks_num : 0
  return [
    {
      // GitCode has no named check list (no check-runs endpoint); this is the
      // single synthetic row that carries the only status it publishes.
      name: tasks > 0 ? `ci (${tasks} task${tasks === 1 ? '' : 's'})` : 'ci',
      state,
      url: `${refUrlBase(ref)}/commit/${pull.head?.sha ?? ''}/checks`,
      workflow: 'gitcode-ci',
      startedAt: null,
      completedAt: state === 'pending' ? null : (pull.updated_at ?? null),
    },
  ]
}

function refUrlBase(ref: ChangeRequestRef): string {
  return `https://${ref.repository.host}/${ref.repository.owner}/${ref.repository.name}`
}

function mergeMethodsOf(pull: GitCodePullJson): readonly MergeMethod[] {
  const mergeState = pull.mergeable_state
  const switchConfig = mergeState?.['merge_request_switch'] as Record<string, unknown> | undefined
  const methods: MergeMethod[] = []
  const configured = typeof switchConfig?.['merge_method'] === 'string' ? switchConfig['merge_method'] : pull.merge_method
  if (configured === 'merge' || configured === 'squash' || configured === 'rebase' || configured === 'merge_commit' || configured === 'fast_forward') {
    methods.push(configured === 'fast_forward' ? 'rebase' : configured === 'merge_commit' ? 'merge' : configured)
  }
  if (switchConfig?.['disable_squash_merge'] === false && !methods.includes('squash')) methods.push('squash')
  if (methods.length === 0) methods.push('merge')
  return methods
}

/** Whether every host-side merge guard passes (the host's own conjunction). */
function mergeReadyOf(pull: GitCodePullJson): boolean {
  const mergeState = pull.mergeable_state
  if (mergeState === undefined) return false
  const guards = Object.entries(mergeState).filter(([key, value]) => key.endsWith('_passed') && typeof value === 'boolean')
  const blocking = guards.filter(([key, value]) => value === false).map(([key]) => key)
  // Approval counters must also meet the required count when the host reports one.
  const required = Number(mergeState['approval_reviewers_required_passed'])
  if (blocking.length > 0 && !(blocking.every((key) => key === 'merged_by_user_passed' || key === 'merge_by_self_passed') && Number.isNaN(required))) {
    // `merged_by_user_passed` reports the signed-in user's own merge permission;
    // a reader without PUSH rights still sees the request as mergeable by others.
    const readerOnly = blocking.filter((key) => key !== 'merged_by_user_passed' && key !== 'merge_by_self_passed')
    if (readerOnly.length > 0) return false
  }
  return true
}

function reviewDecisionOf(pull: GitCodePullJson): ReviewDecision {
  const mergeState = pull.mergeable_state
  if (mergeState === undefined) return 'none'
  const approvers = Number(mergeState['approval_approvers_result'] ?? 0)
  const required = Number(mergeState['approval_required_reviewers_count'] ?? 0)
  if (mergeState['approval_reviewers_required_passed'] === false && approvers > 0) return 'changes-requested'
  if (required > 0 && approvers >= required) return 'approved'
  if (required > 0) return 'review-required'
  return 'none'
}

/**
 * Map one GitCode pull payload to a forge snapshot.
 * @param pull - detail payload (`GET .../pulls/{n}`), or a list row (weaker fields).
 * @param ref - the reference the payload was requested for.
 * @param diffSizes - `files`-derived line counts, when the caller fetched them.
 */
export function snapshotOf(
  pull: GitCodePullJson,
  ref: ChangeRequestRef,
  diffSizes?: { additions: number; deletions: number },
): ChangeRequestSnapshot {
  const { rollup } = ciStateOf(pull)
  const state = stateOf(pull)
  return {
    ref,
    url: pull.html_url ?? `${refUrlBase(ref)}/pull/${ref.number}`,
    title: pull.title ?? '',
    state,
    draft: pull.draft === true,
    author: pull.user?.login ?? null,
    headBranch: pull.head?.ref ?? '',
    headSha: pull.head?.sha ?? '',
    baseBranch: pull.base?.ref ?? '',
    additions: diffSizes?.additions ?? 0,
    deletions: diffSizes?.deletions ?? 0,
    mergeability: mergeabilityOf(pull),
    mergeReady: state === 'open' && pull.draft !== true && mergeReadyOf(pull),
    mergeMethods: mergeMethodsOf(pull),
    reviewDecision: reviewDecisionOf(pull),
    checks: checksOf(pull, ref),
    checksRollup: rollup,
    // GitCode never reports a truncated check list because it reports no list.
    checksTruncated: false,
    // No endpoint exposes per-thread resolution; 0 means "unknown, not counted".
    unresolvedThreads: 0,
    updatedAt: pull.updated_at ?? pull.created_at ?? '',
    closedAt: state === 'open' ? null : (filled(pull.merged_at) ?? filled(pull.closed_at)),
  }
}
