/**
 * GitCode provider capability table (P2 contract constant, ADR P2-2).
 *
 * The upstream `ForgeProvider` type has no `capabilities()` method, so the
 * workbench keeps the table as data instead of reaching into the provider
 * package. Values are copied verbatim from `docs/gitcode-v5-diff.md` §3 and
 * must stay identical to `dsh-forge-gitcode`'s `capabilities()` (a P2 test
 * asserts that, so a drift fails the build instead of surprising the UI).
 */
import type { ProviderCapability } from './forge-provider.ts'

/** The 13 capabilities, with the four the GitCode api/v5 cannot support. */
export const GITCODE_CAPABILITIES: readonly ProviderCapability[] = Object.freeze([
  { capability: 'repositoryFromRemote', implemented: true, note: null },
  { capability: 'changeRequestFromUrl', implemented: true, note: null },
  { capability: 'changeRequestUrl', implemented: true, note: null },
  { capability: 'fetch', implemented: true, note: 'detail endpoint; line counts from the web .diff (the files list cannot page)' },
  {
    capability: 'fetchChecks',
    implemented: false,
    note: 'api/v5 has no check-runs/check list endpoint (404 x5); only mergeable_state.ci_state_passed',
  },
  { capability: 'findByHead', implemented: true, note: null },
  {
    capability: 'readiness',
    implemented: true,
    note: 'GET /api/v5/user; anonymous access answers 403 no scopes:read_user (400 private-token only when the header is missing)',
  },
  {
    capability: 'markReady',
    implemented: false,
    note: 'route proven (OPTIONS: PATCH allowed) but body/permissions need a token probe (diff doc §4)',
  },
  {
    capability: 'merge',
    implemented: false,
    note: 'route proven (PUT /pulls/{n}/merge) but body/permissions need a token probe (diff doc §4)',
  },
  { capability: 'diff', implemented: true, note: 'web /pull/{n}.diff (api .diff answers 400)' },
  { capability: 'fileText', implemented: true, note: 'contents?ref={commit} -> download_url on raw.gitcode.com' },
  { capability: 'fileUrl', implemented: true, note: null },
  {
    capability: 'submitReview',
    implemented: false,
    note: 'comments route proven (OPTIONS: POST); reviews endpoint absent (404); inline shape needs a token probe',
  },
] as const)

/** Names of capabilities the provider declares unsupported. */
export const GITCODE_UNSUPPORTED = Object.freeze(
  GITCODE_CAPABILITIES.filter((entry) => !entry.implemented).map((entry) => entry.capability),
)

/** One issue-side read (not a `ProviderCapability`: the forge table above covers change requests only). */
export interface GitcodeIssueCapability {
  readonly capability: 'gitcodeIssueListMine' | 'gitcodeIssueSearch'
  readonly implemented: boolean
  readonly note: string
}

/**
 * Issue-side read surface measured by P3 (ADR P3-1, `../docs/probes/p3-gitcode-issues.md`).
 *
 * The forge provider table above covers change requests only; the issue poller
 * is a separate reader, so its findings live in their own list. Order is
 * meaningful: the poller uses the first entry and never the second.
 */
export const GITCODE_ISSUE_CAPABILITIES: readonly GitcodeIssueCapability[] = Object.freeze([
  {
    capability: 'gitcodeIssueListMine',
    implemented: true,
    note: 'GET /api/v5/user/issues?filter=created&state=all; token required (anonymous answers 400 private-token); 61 rows measured 2026-11-08T18:25Z',
  },
  {
    capability: 'gitcodeIssueSearch',
    implemented: true,
    note: 'GET /api/v5/search/issues?q=author:<me>; 22 rows for the same subject vs 61 from /user/issues, rows carry no user field, per_page > 50 answers 400: implemented but NOT used as a seed (coverage unknown)',
  },
] as const)
