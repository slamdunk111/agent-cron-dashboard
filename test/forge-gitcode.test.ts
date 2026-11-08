import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ChangeRequestSnapshot, ChecksRollup, Mergeability } from '../packages/dsh-forge-gitcode/src/contracts.ts'
import { countDiffLines, snapshotOf, type GitCodeFileJson, type GitCodePullJson } from '../packages/dsh-forge-gitcode/src/mapping.ts'
import { makeGitCodeProvider, snapshotKey, validateConfig } from '../packages/dsh-forge-gitcode/src/index.ts'
import { changeRequestFromUrl, changeRequestUrl, diffUrl, repositoryFromRemote } from '../packages/dsh-forge-gitcode/src/urls.ts'

const root = resolve(import.meta.dirname, '..')
const fixture = (name: string): unknown => JSON.parse(readFileSync(resolve(root, 'fixtures/gitcode', name), 'utf8'))
const pulls = fixture('pulls-list.json') as GitCodePullJson[]
const pull9723 = fixture('pr-9723.json') as GitCodePullJson
const pullMerged = fixture('pr-merged.json') as GitCodePullJson
const pullOpen = fixture('pr-9724-open.json') as GitCodePullJson
const commits = fixture('pr-9723-commits.json') as { sha: string }[]
const files = fixture('pr-9723-files.json') as GitCodeFileJson[]
const diffText = readFileSync(resolve(root, 'fixtures/gitcode/pr-9723.diff'), 'utf8')
const anonUser = readFileSync(resolve(root, 'fixtures/gitcode/user-anon-403.json'), 'utf8')

const repo = { forge: 'gitcode', host: 'gitcode.com', owner: 'openJiuwen', name: 'jiuwenswarm' } as const
const ref = { repository: repo, number: 9723 }
const signalOf = (): AbortSignal => new AbortController().signal

/** A fetch that replays the captured GitCode responses and records every call. */
function fixtureFetch(overrides: Record<string, { status: number; body: string }> = {}) {
  const calls: string[] = []
  const impl = async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    calls.push(url)
    const custom = overrides[url]
    if (custom !== undefined) return new Response(custom.body, { status: custom.status, headers: { 'content-type': 'application/json' } })
    // Unknown request numbers answer 404 on every endpoint.
    if (/\/pulls\/40400(\/|\.|\?|$)/.test(url)) return new Response('{"error_message":"not found"}', { status: 404 })
    if (url.endsWith('/pulls/9723')) return Response.json(pull9723)
    if (url.includes('/pulls/9723/commits')) return Response.json(commits)
    if (url.includes('/pulls?state=open')) return Response.json(pulls.filter((pull) => pull.state === 'open'))
    if (url.endsWith('/api/v5/user')) return new Response(anonUser, { status: 403, headers: { 'content-type': 'application/json' } })
    if (url.endsWith('.diff')) {
      if (/\/pull\/40400\.diff$/.test(url)) return new Response('{"error_message":"not found"}', { status: 404 })
      return new Response(diffText, { status: 200, headers: { 'content-type': 'text/plain' } })
    }
    if (url.includes('/contents/')) {
      return Response.json({ download_url: 'https://raw.gitcode.com/x', encoding: 'base64', content: Buffer.from('hello').toString('base64') })
    }
    if (url.startsWith('https://raw.gitcode.com')) return new Response('hello', { status: 200 })
    return new Response('{"error_message":"not found"}', { status: 404, headers: { 'content-type': 'application/json' } })
  }
  return { impl: impl as unknown as typeof fetch, calls }
}

describe('gitcode URL recognition', () => {
  it.each([
    ['https://gitcode.com/openJiuwen/jiuwenswarm.git', 'openJiuwen', 'jiuwenswarm'],
    ['https://gitcode.com/openJiuwen/jiuwenswarm', 'openJiuwen', 'jiuwenswarm'],
    ['git@gitcode.com:openJiuwen/jiuwenswarm.git', 'openJiuwen', 'jiuwenswarm'],
    ['ssh://git@gitcode.com/openJiuwen/jiuwenswarm.git', 'openJiuwen', 'jiuwenswarm'],
    ['git+https://gitcode.com/openJiuwen/jiuwenswarm.git', 'openJiuwen', 'jiuwenswarm'],
  ])('maps remote %s', (url, owner, name) => {
    expect(repositoryFromRemote(url)).toEqual({ forge: 'gitcode', host: 'gitcode.com', owner, name })
  })

  it('accepts nested project paths', () => {
    expect(repositoryFromRemote('https://gitcode.com/group/sub/repo.git')).toMatchObject({ owner: 'group/sub', name: 'repo' })
  })

  it.each([
    ['https://github.com/o/r.git', 'another host'],
    ['https://gitcode.com/o', 'too short'],
    ['not a url', 'garbage'],
  ])('rejects %s (%s)', (url) => {
    expect(repositoryFromRemote(url)).toBeUndefined()
  })

  it.each([
    ['https://gitcode.com/o/r/pull/12', 12],
    ['https://gitcode.com/o/r/pulls/12', 12],
    ['https://gitcode.com/o/r/merge_requests/12', 12],
    ['https://gitcode.com/group/sub/repo/pull/9', 9],
  ])('maps change request url %s', (url, number) => {
    const parsed = changeRequestFromUrl(url)
    expect(parsed?.number).toBe(number)
    expect(parsed?.repository.name).toBe(url.includes('sub') ? 'repo' : 'r')
  })

  it('rejects non-change-request urls', () => {
    expect(changeRequestFromUrl('https://gitcode.com/o/r/issues/1')).toBeUndefined()
    expect(changeRequestFromUrl('https://gitcode.com/o/r/pull/abc')).toBeUndefined()
    expect(changeRequestFromUrl('https://github.com/o/r/pull/1')).toBeUndefined()
  })

  it('canonicalizes to the /pull/ form and derives API and diff urls', () => {
    expect(changeRequestUrl(ref)).toBe('https://gitcode.com/openJiuwen/jiuwenswarm/pull/9723')
    expect(diffUrl(ref)).toBe('https://gitcode.com/openJiuwen/jiuwenswarm/pull/9723.diff')
    expect(changeRequestFromUrl(changeRequestUrl(ref))).toEqual(ref)
  })
})

describe('gitcode snapshot mapping (fixture PR #9723)', () => {
  it('maps the captured detail payload', () => {
    const snapshot = snapshotOf(pull9723, ref)
    expect(snapshot).toMatchObject({
      // #9723 was open when captured (GitCode sends "" for absent timestamps).
      state: 'open',
      draft: false,
      author: 'thesky58',
      headBranch: 'fix/history-wire-truncation-markers',
      headSha: 'e1cbf1ff931bebf704a69378ef62d352c53d86d4',
      baseBranch: 'develop',
      mergeability: 'mergeable',
      mergeReady: false,
    })
    // #9723 was open when captured; the host reports ci_state_passed=false with
    // 1 task: checks exist and do not pass, so the rollup is `failure`.
    expect(snapshot.checksRollup).toBe('failure')
    expect(snapshot.checks).toHaveLength(1)
    expect(snapshot.checks[0]?.name).toContain('ci')
    expect(snapshot.mergeMethods).toEqual(['merge', 'squash'])
    expect(snapshot.reviewDecision).toBe('none')
    expect(snapshot.closedAt).toBeNull()
  })

  it('maps a genuinely merged payload (pr-merged.json)', () => {
    const snapshot = snapshotOf(pullMerged, ref)
    expect(snapshot.state).toBe('merged')
    expect(snapshot.closedAt).toBe('2026-11-07T19:23:56+08:00')
    expect(snapshot.mergeReady).toBe(false)
  })

  it('counts the captured patch to the numbers the files list reports', () => {
    // `fixtures/gitcode/pr-9723-files.json` sums to 387/26 on the host; the
    // patch is the source the provider actually counts.
    const filesSum = files.reduce<{ additions: number; deletions: number }>(
      (total, file) => ({ additions: total.additions + (file.additions ?? 0), deletions: total.deletions + (file.deletions ?? 0) }),
      { additions: 0, deletions: 0 },
    )
    expect(filesSum).toEqual({ additions: 387, deletions: 26 })
    expect(countDiffLines(diffText)).toEqual(filesSum)
  })

  it('maps lifecycle and conflict states', () => {
    const states = pulls.map((pull) => snapshotOf(pull, { repository: repo, number: pull.number ?? 0 }).state)
    expect(states.every((state) => ['open', 'closed', 'merged'].includes(state))).toBe(true)
    const conflicting = snapshotOf(
      { ...pull9723, mergeable_state: { ...(pull9723.mergeable_state as Record<string, unknown>), conflict_passed: false } },
      ref,
    )
    expect(conflicting.mergeability).toBe('conflicting')
    expect(conflicting.mergeReady).toBe(false)
  })

  it('maps ci_state_passed true to success, and a missing field to none', () => {
    const passing = snapshotOf(
      { ...pull9723, mergeable_state: { ...(pull9723.mergeable_state as Record<string, unknown>), ci_state_passed: true } },
      ref,
    )
    expect(passing.checksRollup).toBe('success')
    expect(passing.checks[0]?.state).toBe('success')
    const noCi = snapshotOf({ ...pull9723, mergeable_state: {}, check_tasks_num: 0 }, ref)
    expect(noCi.checksRollup).toBe('none')
    expect(noCi.checks).toHaveLength(0)
  })

  it('maps the open PR #9724 payload (ci failing with 1 task)', () => {
    const snapshot = snapshotOf(pullOpen, { repository: repo, number: 9724 })
    expect(snapshot.state).toBe('open')
    expect(snapshot.checksRollup).toBe('failure')
    expect(snapshot.checks[0]?.state).toBe('failure')
  })

  it('maps a draft open request as not merge ready', () => {
    const draft = snapshotOf({ ...pull9723, draft: true, state: 'open', merged_at: null }, ref)
    expect(draft.draft).toBe(true)
    expect(draft.mergeReady).toBe(false)
  })

  it('exposes a checks rollup type that covers every forge value', () => {
    const rollups: ChecksRollup[] = ['none', 'pending', 'success', 'failure']
    const mergeability: Mergeability[] = ['mergeable', 'conflicting', 'unknown']
    expect(rollups).toHaveLength(4)
    expect(mergeability).toHaveLength(3)
  })
})

describe('gitcode provider over replayed HTTP', () => {
  const config = validateConfig({})

  it('fetch reads the detail payload and folds in the patch line counts', async () => {
    const { impl, calls } = fixtureFetch()
    const provider = makeGitCodeProvider(config, { fetch: impl })
    const result = await provider.fetch([ref], signalOf())
    const snapshot = result.get(snapshotKey(ref)) as ChangeRequestSnapshot
    // Counted from fixtures/gitcode/pr-9723.diff, the same numbers the files
    // list reports for this request (387/26).
    expect({ additions: snapshot.additions, deletions: snapshot.deletions }).toEqual({ additions: 387, deletions: 26 })
    expect(calls.some((url) => url.endsWith('/pull/9723.diff'))).toBe(true)
    expect(calls.some((url) => url.includes('/files'))).toBe(false)
  })

  it('fetch returns a mapped failure for a missing request', async () => {
    const { impl } = fixtureFetch()
    const provider = makeGitCodeProvider(config, { fetch: impl })
    const missing = { repository: repo, number: 40400 }
    const result = await provider.fetch([missing], signalOf())
    expect(result.get(snapshotKey(missing))).toMatchObject({ code: 'not-found' })
  })

  it('fetch honours an abort signal before the request starts', async () => {
    const { impl, calls } = fixtureFetch()
    const provider = makeGitCodeProvider(config, { fetch: impl })
    const controller = new AbortController()
    controller.abort()
    const result = await provider.fetch([ref], controller.signal)
    expect(result.get(snapshotKey(ref))).toMatchObject({ code: 'unavailable' })
    expect(calls).toHaveLength(0)
  })

  it('readiness reports unauthenticated when anonymous access is refused', async () => {
    const { impl } = fixtureFetch()
    const provider = makeGitCodeProvider(config, { fetch: impl, token: undefined })
    const readiness = await provider.readiness('gitcode.com', signalOf())
    expect(readiness.state).toBe('unauthenticated')
  })

  it('readiness reports ready when the token is accepted', async () => {
    const impl = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/api/v5/user')) return Response.json({ login: 'someone' })
      return new Response('{}', { status: 404 })
    }) as unknown as typeof fetch
    const provider = makeGitCodeProvider(config, { fetch: impl, token: 't' })
    expect(await provider.readiness('gitcode.com', signalOf())).toMatchObject({ state: 'ready' })
  })

  it('diff reads the web patch and maps a 404', async () => {
    const { impl } = fixtureFetch()
    const provider = makeGitCodeProvider(config, { fetch: impl })
    const text = await provider.diff(ref, signalOf())
    expect(typeof text).toBe('string')
    expect(String(text).startsWith('diff --git')).toBe(true)
    const missing = await provider.diff({ repository: repo, number: 40400 }, signalOf())
    expect(missing).not.toEqual(expect.any(String))
    expect((missing as { code?: string }).code).toBe('not-found')
  })

  it('fileText follows download_url and falls back to base64 content', async () => {
    const { impl } = fixtureFetch()
    const provider = makeGitCodeProvider(config, { fetch: impl })
    expect(await provider.fileText(ref, 'e1cbf1f', 'a/b.py', signalOf())).toBe('hello')
    const inline = makeGitCodeProvider(config, {
      fetch: (async () => Response.json({ content: Buffer.from('inline').toString('base64'), encoding: 'base64', download_url: null })) as unknown as typeof fetch,
    })
    expect(await inline.fileText(ref, 'e1cbf1f', 'a/b.py', signalOf())).toBe('inline')
  })

  it('fileUrl is derived without network access', () => {
    const provider = makeGitCodeProvider(config, { fetch: fixtureFetch().impl })
    expect(provider.fileUrl(ref, 'abc123', '/src/x.ts')).toBe('https://gitcode.com/openJiuwen/jiuwenswarm/blob/abc123/src/x.ts')
  })

  it('findByHead filters the open list by the requested branch', async () => {
    const { impl } = fixtureFetch({
      'https://gitcode.com/api/v5/repos/openJiuwen/jiuwenswarm/pulls?state=open&head=fix%2Fhistory-wire-truncation-markers&per_page=100': {
        status: 200,
        body: JSON.stringify(pulls.filter((pull) => pull.head?.ref === 'fix/history-wire-truncation-markers')),
      },
    })
    const provider = makeGitCodeProvider(config, { fetch: impl })
    const found = await provider.findByHead(repo, 'fix/history-wire-truncation-markers', signalOf())
    expect(found).toEqual([{ repository: repo, number: 9723 }])
  })

  it('maps a 400 private-token refusal to unauthenticated, and 429 to unavailable', async () => {
    const auth = makeGitCodeProvider(config, {
      fetch: (async () => new Response('{"error_message":"Invalid header parameter: private-token, required"}', { status: 400 })) as unknown as typeof fetch,
    })
    const result = await auth.fetch([ref], signalOf())
    expect(result.get(snapshotKey(ref))).toMatchObject({ code: 'unauthenticated' })
    const limited = makeGitCodeProvider(config, {
      fetch: (async () => new Response('{"error_message":"too many requests"}', { status: 429 })) as unknown as typeof fetch,
    })
    expect((await limited.fetch([ref], signalOf())).get(snapshotKey(ref))).toMatchObject({ code: 'unavailable' })
  })

  it('refuses oversized bodies as too-large', async () => {
    const small = validateConfig({ maxOutputBytes: 10 })
    const { impl } = fixtureFetch()
    const provider = makeGitCodeProvider(small, { fetch: impl })
    const result = await provider.fetch([ref], signalOf())
    expect(result.get(snapshotKey(ref))).toMatchObject({ code: 'too-large' })
  })

  it('declares the measured capability table', () => {
    const provider = makeGitCodeProvider(config, { fetch: fixtureFetch().impl })
    const table = provider.capabilities()
    const implemented = (name: string): boolean => table.find((row) => row.capability === name)?.implemented === true
    expect(implemented('fetch')).toBe(true)
    expect(implemented('diff')).toBe(true)
    expect(implemented('fileText')).toBe(true)
    expect(implemented('fetchChecks')).toBe(false)
    expect(implemented('submitReview')).toBe(false)
    expect(implemented('merge')).toBe(false)
    expect(table.find((row) => row.capability === 'fetchChecks')?.note).toContain('404')
  })

  it('rejects a malformed row config', () => {
    expect(() => validateConfig({ tokenEnv: 'gitcode-token' })).toThrow(/environment variable NAME/)
    expect(() => validateConfig({ hosts: ['bad host'] })).toThrow(/invalid host/)
    expect(() => validateConfig({ timeoutMs: 0 })).toThrow(/timeoutMs/)
  })
})

describe('documented gaps stay documented', () => {
  it('capability notes point at the difference table', () => {
    const table = makeGitCodeProvider(validateConfig({}), { fetch: fixtureFetch().impl }).capabilities()
    const noted = table.filter((row) => !row.implemented)
    expect(noted.length).toBeGreaterThanOrEqual(4)
    for (const row of noted) expect(row.note).toMatch(/diff doc|404|authenticated/)
  })
})

describe('plugin row exports', () => {
  it('declares the row name and the forge injection', async () => {
    const mod = await import('../packages/dsh-forge-gitcode/src/index.ts')
    expect(mod.name).toBe('forge-gitcode')
    expect(mod.inject).toEqual(['forge'])
  })
})

describe('files pagination and no-token fallback (C4)', () => {
  it('reports binary patches as unavailable instead of 0/0 (R4-01)', async () => {
    const impl = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('.diff')) return new Response('diff --git a/i.png b/i.png\nGIT binary patch\nliteral 12\n', { status: 200 })
      return Response.json(pullOpen)
    }) as unknown as typeof fetch
    const provider = makeGitCodeProvider(validateConfig({}), { fetch: impl })
    expect((await provider.fetch([ref], signalOf())).get(snapshotKey(ref))).toMatchObject({ code: 'unavailable' })
  })

  it('reads public repositories with no token at all (clip below 400/403)', async () => {
    const headersSeen: { privateToken?: string }[] = []
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      headersSeen.push({ privateToken: (init?.headers as Record<string, string> | undefined)?.['private-token'] })
      // The files read must answer an array; a single PR object makes the
      // provider fail (which is the C3 behaviour, not what this case checks).
      if (url.includes('/files')) return Response.json([{ filename: 'f', additions: 1, deletions: 0 }])
      return Response.json(pullOpen)
    }) as unknown as typeof fetch
    // `token: ''` means "definitely no token"; leaving it undefined would fall
    // back to the environment and make the case host-dependent.
    const provider = makeGitCodeProvider(validateConfig({}), { fetch: impl, token: '' })
    const result = await provider.fetch([ref], signalOf())
    expect((result.get(snapshotKey(ref)) as ChangeRequestSnapshot).state).toBe('open')
    expect(headersSeen.every((entry) => entry.privateToken === undefined)).toBe(true)
  })
})

describe('P1 review fixes R2 (redirects, payload shape, ci branch)', () => {
  it('refuses a redirect instead of forwarding credentials (C1 residual)', async () => {
    const calls: { url: string; redirect: string | undefined }[] = []
    // The double records what the transport asked for and answers 302 either
    // way; the provider must refuse it without ever asking for a second request.
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      calls.push({ url, redirect: init?.redirect })
      return new Response('', { status: 302, headers: { location: 'https://evil.example/steal' } })
    }) as unknown as typeof fetch
    const provider = makeGitCodeProvider(validateConfig({}), { fetch: impl, token: 'secret-token' })
    const result = await provider.fetch([ref], signalOf())
    expect(result.get(snapshotKey(ref))).toMatchObject({ code: 'unavailable' })
    // One request only, and it was made with redirects disabled.
    expect(calls).toHaveLength(1)
    expect(calls[0]?.redirect).toBe('manual')
    expect(calls.every((call) => !call.url.includes('evil.example'))).toBe(true)
  })

  it('fails when the patch cannot be read for line counts (C3 residual)', async () => {
    const impl = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('.diff')) return new Response('{"error_message":"nope"}', { status: 500 })
      return Response.json(pullOpen)
    }) as unknown as typeof fetch
    const provider = makeGitCodeProvider(validateConfig({}), { fetch: impl })
    expect((await provider.fetch([ref], signalOf())).get(snapshotKey(ref))).toMatchObject({ code: 'unavailable' })
  })

  it('maps ci_state_passed=false with zero tasks to none, not failure (M-M3)', () => {
    const noTasks = snapshotOf(
      { ...pullOpen, check_tasks_num: 0, mergeable_state: { ...(pullOpen.mergeable_state as Record<string, unknown>), ci_state_passed: false } },
      ref,
    )
    expect(noTasks.checksRollup).toBe('none')
  })

  it.each([
    [{ approval_required_reviewers_count: 2, approval_approvers_result: 1, approval_reviewers_required_passed: false }, 'review-required'],
    [{ approval_required_reviewers_count: 2, approval_approvers_result: 2, approval_reviewers_required_passed: true }, 'approved'],
    [{ approval_required_reviewers_count: 0, approval_approvers_result: 3, approval_reviewers_required_passed: false }, 'review-required'],
    [{ approval_required_reviewers_count: 0, approval_approvers_result: 0, approval_reviewers_required_passed: true }, 'none'],
  ])('approval state %j maps to %s and never changes-requested (M-C2)', (mergeState, expected) => {
    const snapshot = snapshotOf({ ...pullOpen, mergeable_state: mergeState }, ref)
    // An exact value, so a revived `changes-requested` branch fails this case.
    expect(snapshot.reviewDecision).toBe(expected)
  })
})

describe('P1 review fixes (C1-C3)', () => {
  const config = validateConfig({ tokenEnv: 'GITCODE_TOKEN' })

  it('never sends the token to a host this provider does not serve (C1)', async () => {
    const seen: { url: string; token: string | undefined }[] = []
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      seen.push({ url, token: (init?.headers as Record<string, string>)['private-token'] })
      return Response.json(pullOpen)
    }) as unknown as typeof fetch
    const provider = makeGitCodeProvider(config, { fetch: impl, token: 'secret-token' })
    const evil = { repository: { forge: 'gitcode', host: 'evil.example', owner: 'o', name: 'n' }, number: 1 }
    const result = await provider.fetch([evil], signalOf())
    expect(result.get(snapshotKey(evil))).toMatchObject({ code: 'unavailable' })
    expect(await provider.readiness('evil.example', signalOf())).toMatchObject({ state: 'unavailable' })
    expect(await provider.diff(evil, signalOf())).toMatchObject({ code: 'unavailable' })
    expect(await provider.fileText(evil, 'sha', 'p', signalOf())).toMatchObject({ code: 'unavailable' })
    expect(await provider.findByHead(evil.repository, 'b', signalOf())).toEqual([])
    expect(seen).toHaveLength(0)
  })

  it('sends the token only to the served host (C1)', async () => {
    const tokens: Record<string, string | undefined> = {}
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      tokens[new URL(url).hostname] = (init?.headers as Record<string, string>)['private-token']
      if (url.includes('/contents/')) return Response.json({ download_url: 'https://raw.gitcode.com/x', encoding: 'base64', content: '' })
      return new Response('hello', { status: 200 })
    }) as unknown as typeof fetch
    const provider = makeGitCodeProvider(config, { fetch: impl, token: 'secret-token' })
    await provider.fileText(ref, 'sha', 'a/b', signalOf())
    expect(tokens['gitcode.com']).toBe('secret-token')
    expect(tokens['raw.gitcode.com']).toBeUndefined()
  })

  it('reports 1 of 2 approvals as review-required, never changes-requested (C2)', () => {
    const mergeState = { approval_required_reviewers_count: 2, approval_approvers_result: 1, approval_reviewers_required_passed: false }
    const snapshot = snapshotOf({ ...pullOpen, mergeable_state: mergeState }, ref)
    expect(snapshot.reviewDecision).toBe('review-required')
    const enough = snapshotOf({ ...pullOpen, mergeable_state: { ...mergeState, approval_approvers_result: 2 } }, ref)
    expect(enough.reviewDecision).toBe('approved')
  })

  it('fails the snapshot when the size read fails instead of reporting 0/0 (C3)', async () => {
    const impl = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('.diff')) return new Response('{"error_message":"boom"}', { status: 500 })
      return Response.json(pullOpen)
    }) as unknown as typeof fetch
    const provider = makeGitCodeProvider(config, { fetch: impl })
    const result = await provider.fetch([ref], signalOf())
    expect(result.get(snapshotKey(ref))).toMatchObject({ code: 'unavailable' })
  })

  it('reports too-large when the patch exceeds maxOutputBytes (C3)', async () => {
    const impl = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/files')) return Response.json([{ filename: 'f', additions: 1, deletions: 0 }])
      if (url.endsWith('.diff')) return new Response(diffText, { status: 200 })
      return Response.json(pullOpen)
    }) as unknown as typeof fetch
    const provider = makeGitCodeProvider(validateConfig({ maxOutputBytes: 200 }), { fetch: impl })
    expect((await provider.fetch([ref], signalOf())).get(snapshotKey(ref))).toMatchObject({ code: 'too-large' })
  })
})

describe('R5 hardening (bytes, encoding, malformed body)', () => {
  it('counts the output limit in bytes, not UTF-16 units (P2)', async () => {
    // Four-byte characters: 40 of them are 160 bytes but only 80 UTF-16 units,
    // so a UTF-16-based limit of 100 would let this through.
    const body = '{"title":"' + '😀'.repeat(40) + '"}'
    const impl = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('.diff')) return new Response('diff --git a/a b/b\n@@ -1 +1 @@\n-x\n+y\n', { status: 200 })
      return new Response(body, { status: 200 })
    }) as unknown as typeof fetch
    const strict = makeGitCodeProvider(validateConfig({ maxOutputBytes: 100, filesPageSize: 0 }), { fetch: impl })
    expect((await strict.fetch([ref], signalOf())).get(snapshotKey(ref))).toMatchObject({ code: 'too-large' })
  })

  it('maps an invalid UTF-8 body to a failure instead of rejecting (P2)', async () => {
    const impl = (async () => new Response(new Uint8Array([0xff, 0xfe, 0x00]), { status: 200 })) as unknown as typeof fetch
    const provider = makeGitCodeProvider(validateConfig({}), { fetch: impl })
    expect((await provider.fetch([ref], signalOf())).get(snapshotKey(ref))).toMatchObject({ code: 'unavailable' })
  })

  it('encodes every path segment of fileText (P2)', async () => {
    const urls: string[] = []
    const impl = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString()
      urls.push(url)
      return Response.json({ content: Buffer.from('ok').toString('base64'), encoding: 'base64' })
    }) as unknown as typeof fetch
    const provider = makeGitCodeProvider(validateConfig({}), { fetch: impl })
    await provider.fileText(ref, 'abc', 'docs/a b/c#d?x', signalOf())
    const request = urls[0] ?? ''
    // `?` inside a path must not start the query string.
    expect(request).toContain('/contents/docs/a%20b/c%23d%3Fx?ref=abc')
    expect(request.indexOf('?ref=')).toBe(request.lastIndexOf('?'))
  })
})

describe('patch counting ignores header look-alikes (R7-P1-01)', () => {
  it('counts a deleted `-- comment` and an added `++ x` line', () => {
    const patch = [
      'diff --git a/docs/x.md b/docs/x.md',
      '--- a/docs/x.md',
      '+++ b/docs/x.md',
      '@@ -1,3 +1,3 @@ heading',
      ' keep',
      '--- this is a deleted markdown rule',
      '- removed',
      '+++ this is an added double-plus line',
      '+ added',
    ].join('\n')
    expect(countDiffLines(patch)).toEqual({ additions: 2, deletions: 2 })
  })
})
