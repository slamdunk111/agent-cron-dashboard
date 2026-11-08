/**
 * GitCode api/v5 provider for the dsh experimental forge registry.
 *
 * Registration follows `@deepseek-ai/dsh-experimental-forge-github`:
 * `ctx.forge.register(provider)` inside `apply`, with `inject = ['forge']`.
 *
 * Capabilities are declared from measured endpoints
 * (`../../docs/gitcode-v5-diff.md` §3), and anything the host does not expose is
 * left unimplemented so forge degrades gracefully instead of failing at
 * runtime. Writes (`markReady`, `merge`, `submitReview`) stay undeclared until
 * a token-authenticated probe closes their endpoint shapes (diff doc §4).
 */
import type { Context } from '@deepseek-ai/cordis'
import type {
  ChangeRequestRef as ForgeChangeRequestRef,
  ChangeRequestSnapshot,
  ForgeFailure,
  ForgeRepository,
  ForgeReadiness,
  ProviderCapability,
} from './contracts.ts'
import type { GitCodeChangeRequestRef, GitCodeRepository } from './urls.ts'
import { apiBase, changeRequestFromUrl, changeRequestUrl, diffUrl, fileUrl, repositoryFromRemote } from './urls.ts'
import { countDiffLines, snapshotOf, type GitCodePullJson } from './mapping.ts'
import { parseJson, request, type TransportFeatures } from './transport.ts'

/** Row name recorded by dsh's loader. */
export const name = 'forge-gitcode'

/**
 * The forge registry is provided by `@deepseek-ai/dsh-experimental-forge`.
 * Without this declaration cordis' service proxy refuses the read, and the row
 * fails to activate (measured: `cannot get property "forge" without inject`).
 */
export const inject = ['forge']

/**
 * Token env name rule. The same rule lives in `contracts/config-validate.ts`
 * validateTokenEnv; a note in ADR P0-4 records why a package-local copy is kept.
 */
const TOKEN_ENV_RE = /^[A-Z][A-Z0-9_]*$/

export interface Config {
  /** Name of the environment variable that holds the GitCode access token (default `GITCODE_TOKEN`). */
  tokenEnv?: string
  /** GitCode web host; `api/v5` calls are derived from it. */
  host?: string
  /** Hosts this provider serves (GitCode has one public host; Enterprise hosts go here). */
  hosts?: readonly string[]
  /** Deadline for one API request. */
  timeoutMs?: number
  /** Largest accepted response body. */
  maxOutputBytes?: number
  /** 0 disables the extra patch read (line counts then stay 0). */
  filesPageSize?: number
}

/** Defaults applied before validation; mirrors `cordis.patch.yml`. */
export const DEFAULT_CONFIG = {
  tokenEnv: 'GITCODE_TOKEN',
  host: 'gitcode.com',
  hosts: ['gitcode.com'],
  timeoutMs: 20_000,
  maxOutputBytes: 8 * 1024 * 1024,
  filesPageSize: 100,
} as const satisfies Required<Config>

/**
 * Validate a row config.
 *
 * Same rule as `contracts/config-validate.ts` validateTokenEnv: the value is an
 * environment variable NAME (3..128 upper-case characters). Credential literals
 * cannot pass this pattern, so no separate blacklist is needed.
 * @throws Error when any field is malformed.
 */
export function validateConfig(config: Config): Required<Config> {
  const merged = { ...DEFAULT_CONFIG, ...config }
  if (typeof merged.tokenEnv !== 'string' || merged.tokenEnv.length < 3 || merged.tokenEnv.length > 128 || !TOKEN_ENV_RE.test(merged.tokenEnv)) {
    throw new Error('tokenEnv must be an environment variable NAME (A-Z0-9_ only, 3..128 characters)')
  }
  if (typeof merged.host !== 'string' || merged.host.length === 0) throw new Error('host must be a non-empty string')
  if (merged.hosts.length === 0) throw new Error('hosts must list at least one host')
  for (const host of merged.hosts) {
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(host)) {
      throw new Error(`invalid host ${JSON.stringify(host)}`)
    }
  }
  if (!Number.isSafeInteger(merged.timeoutMs) || merged.timeoutMs <= 0) throw new Error('timeoutMs must be a positive integer')
  if (!Number.isSafeInteger(merged.maxOutputBytes) || merged.maxOutputBytes <= 0) throw new Error('maxOutputBytes must be a positive integer')
  if (!Number.isSafeInteger(merged.filesPageSize) || merged.filesPageSize < 0 || merged.filesPageSize > 100) {
    throw new Error('filesPageSize must be an integer 0..100')
  }
  return merged
}

/** Whether a token is present in the environment (never returns the token itself). */
export function hasToken(config: Required<Config>, env: NodeJS.ProcessEnv = process.env): boolean {
  const token = env?.[config.tokenEnv]
  return typeof token === 'string' && token.length > 0
}

function readToken(config: Required<Config>, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const token = env?.[config.tokenEnv]
  return typeof token === 'string' && token.length > 0 ? token : undefined
}

/** Capability table, filled from the measured v5 endpoints. */
export function capabilities(): readonly ProviderCapability[] {
  return [
    { capability: 'repositoryFromRemote', implemented: true, note: null },
    { capability: 'changeRequestFromUrl', implemented: true, note: null },
    { capability: 'changeRequestUrl', implemented: true, note: null },
    { capability: 'fetch', implemented: true, note: 'detail endpoint; line counts from the web .diff (the files list cannot page)' },
    { capability: 'fetchChecks', implemented: false, note: 'api/v5 has no check-runs/check list endpoint (404 x5); only mergeable_state.ci_state_passed' },
    { capability: 'findByHead', implemented: true, note: null },
    { capability: 'readiness', implemented: true, note: 'GET /api/v5/user; anonymous access answers 403 no scopes:read_user (400 private-token only when the header is missing)' },
    { capability: 'markReady', implemented: false, note: 'route proven (OPTIONS: PATCH allowed) but body/permissions need a token probe (diff doc §4)' },
    { capability: 'merge', implemented: false, note: 'route proven (PUT /pulls/{n}/merge) but body/permissions need a token probe (diff doc §4)' },
    { capability: 'diff', implemented: true, note: 'web /pull/{n}.diff (api .diff answers 400)' },
    { capability: 'fileText', implemented: true, note: 'contents?ref={commit} -> download_url on raw.gitcode.com' },
    { capability: 'fileUrl', implemented: true, note: null },
    { capability: 'submitReview', implemented: false, note: 'comments route proven (OPTIONS: POST); reviews endpoint absent (404); inline shape needs a token probe' },
  ]
}

/** A provider plus the internals tests drive directly. */
export interface GitCodeProvider {
  readonly forge: 'gitcode'
  repositoryFromRemote(url: string): ForgeRepository | undefined
  changeRequestFromUrl(url: string): ForgeChangeRequestRef | undefined
  changeRequestUrl(ref: ForgeChangeRequestRef): string
  fetch(refs: readonly ForgeChangeRequestRef[], signal: AbortSignal): Promise<ReadonlyMap<string, ChangeRequestSnapshot | ForgeFailure>>
  findByHead(repository: ForgeRepository, branch: string, signal: AbortSignal): Promise<readonly ForgeChangeRequestRef[]>
  readiness(host: string, signal: AbortSignal): Promise<ForgeReadiness>
  diff(ref: ForgeChangeRequestRef, signal: AbortSignal): Promise<string | ForgeFailure>
  fileText(ref: ForgeChangeRequestRef, commit: string, path: string, signal: AbortSignal): Promise<string | ForgeFailure>
  fileUrl(ref: ForgeChangeRequestRef, commit: string, path: string): string
  capabilities(): readonly ProviderCapability[]
}

/** Key used for the `fetch` result map: `<forge>:<host>/<owner>/<name>#<number>`. */
export function snapshotKey(ref: ForgeChangeRequestRef): string {
  const repository = ref.repository
  return `${repository.forge}:${repository.host}/${repository.owner}/${repository.name}#${ref.number}`.toLowerCase()
}

function asGitCode(ref: ForgeChangeRequestRef): GitCodeChangeRequestRef {
  return {
    repository: { ...ref.repository } satisfies GitCodeRepository,
    number: ref.number,
  }
}

/**
 * Build the provider.
 * @param config - validated row config.
 * @param features - injectable fetch and env (tests pass a fixture-backed fetch).
 */
export function makeGitCodeProvider(config: Required<Config>, features: TransportFeatures = {}): GitCodeProvider {
  const transport: TransportFeatures = {
    ...features,
    token: features.token !== undefined ? features.token : readToken(config),
    timeoutMs: config.timeoutMs,
    maxOutputBytes: config.maxOutputBytes,
  }
  const hosts = config.hosts
  /**
   * Credentials only ever travel to a host this provider serves. A caller can
   * hand any string in `ForgeChangeRequestRef.repository.host`, so every read
   * re-checks it before a request (and its token) is built.
   */
  const served = (host: string | undefined): boolean =>
    typeof host === 'string' && hosts.includes(host.toLowerCase())
  const transportFor = (host: string): TransportFeatures => (served(host) ? transport : { ...transport, token: undefined })

  async function readPull(ref: ForgeChangeRequestRef, signal: AbortSignal): Promise<ChangeRequestSnapshot | ForgeFailure> {
    if (!served(ref.repository.host)) {
      return { code: 'unavailable', message: `host ${ref.repository.host} is not served by this provider` }
    }
    const gitcode = asGitCode(ref)
    const result = await request(`${apiBase(gitcode)}/pulls/${ref.number}`, transport, signal)
    if (!result.ok) return result.failure
    const parsed = parseJson(result.text)
    if (!parsed.ok) return parsed.failure
    const pull = parsed.value as GitCodePullJson
    if (config.filesPageSize === 0) return snapshotOf(pull, ref)
    const sizes = await readSizes(gitcode, signal)
    // A failed or oversized files page makes the line counts unknowable, and
    // reporting 0/0 would be a wrong number rather than an honest failure.
    if ('code' in sizes) return sizes
    return snapshotOf(pull, ref, sizes)
  }

  /**
   * Line counts of the change request, from the host's own unified patch.
   *
   * Measured: the `files` list endpoint IGNORES `page`/`per_page` (page 2 of a
   * 3-file and of a 14-file request returns the identical first page), so
   * paging it would silently mis-count. The web `.diff` has no such cap and
   * its `diff --git` block count equals the `files` row count on every sampled
   * request, so the patch is the honest source; a patch over
   * `maxOutputBytes` reports `too-large` instead of an undercount.
   */
  async function readSizes(ref: GitCodeChangeRequestRef, signal: AbortSignal): Promise<{ additions: number; deletions: number } | ForgeFailure> {
    const result = await request(diffUrl(ref), transport, signal, 'text/plain')
    if (!result.ok) return result.failure
    if (result.text.includes('GIT binary patch')) {
      // Binary diffs carry no `+`/`-` body lines; counting them as 0/0 would be
      // a wrong number for a request that changed binaries.
      return { code: 'unavailable', message: 'the patch contains binary files; line counts are not available from the diff' }
    }
    return countDiffLines(result.text)
  }

  return {
    forge: 'gitcode',
    repositoryFromRemote: (url) => repositoryFromRemote(url, hosts),
    changeRequestFromUrl: (url) => changeRequestFromUrl(url, hosts),
    changeRequestUrl: (ref) => changeRequestUrl(asGitCode(ref)),
    async fetch(refs, signal) {
      const out = new Map<string, ChangeRequestSnapshot | ForgeFailure>()
      for (const ref of refs) out.set(snapshotKey(ref), await readPull(ref, signal))
      return out
    },
    async findByHead(repository, branch, signal) {
      if (!served(repository.host)) return []
      const ref: GitCodeChangeRequestRef = { repository: { ...repository }, number: 0 }
      const result = await request(
        `${apiBase(ref)}/pulls?state=open&head=${encodeURIComponent(branch)}&per_page=100`,
        transport,
        signal,
      )
      if (!result.ok) {
        // `findByHead` returns a list, not failures: an unreadable list is empty
        // (forge keeps watching; the next poll reports the failure instead).
        return []
      }
      const parsed = parseJson(result.text)
      if (!parsed.ok || !Array.isArray(parsed.value)) return []
      return (parsed.value as GitCodePullJson[])
        .filter((pull) => typeof pull.number === 'number' && pull.head?.ref === branch)
        .map((pull) => ({ repository, number: pull.number as number }))
    },
    async readiness(host, signal) {
      if (!served(host)) return { state: 'unavailable', message: `host ${host} is not served by this provider` }
      const result = await request(`https://${host}/api/v5/user`, transport, signal)
      if (result.ok) return { state: 'ready', message: null }
      if (result.failure.code === 'unauthenticated') {
        return { state: 'unauthenticated', message: 'set the env variable named by tokenEnv to a GitCode access token' }
      }
      return { state: 'unavailable', message: result.failure.message }
    },
    async diff(ref, signal) {
      if (!served(ref.repository.host)) {
        return { code: 'unavailable', message: `host ${ref.repository.host} is not served by this provider` }
      }
      const result = await request(diffUrl(asGitCode(ref)), transport, signal, 'text/plain')
      if (!result.ok) return result.failure
      return result.text
    },
    async fileText(ref, commit, path, signal) {
      if (!served(ref.repository.host)) {
        return { code: 'unavailable', message: `host ${ref.repository.host} is not served by this provider` }
      }
      const gitcode = asGitCode(ref)
      const encoded = path
        .replace(/^\//, '')
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/')
      const result = await request(`${apiBase(gitcode)}/contents/${encoded}?ref=${encodeURIComponent(commit)}`, transport, signal)
      if (!result.ok) return result.failure
      const parsed = parseJson(result.text)
      if (!parsed.ok) return parsed.failure
      const entry = parsed.value as { download_url?: string; content?: string; encoding?: string }
      if (typeof entry.download_url === 'string') {
        // `download_url` points at raw.gitcode.com; it never receives the token.
        let downloadHost: string
        try {
          downloadHost = new URL(entry.download_url).hostname
        } catch {
          return { code: 'unavailable', message: `unparsable download_url for ${path}` }
        }
        const raw = await request(entry.download_url, transportFor(downloadHost), signal, 'text/plain')
        return raw.ok ? raw.text : raw.failure
      }
      if (typeof entry.content === 'string' && entry.encoding === 'base64') {
        return Buffer.from(entry.content, 'base64').toString('utf8')
      }
      return { code: 'unavailable', message: `no text available for ${path} at ${commit}` }
    },
    fileUrl: (ref, commit, path) => fileUrl(asGitCode(ref), commit, path),
    capabilities,
  }
}

/** Line counts of a patch, exported for callers that only get `.diff` text. */
export { countDiffLines }

/** Cordis entry: validate the row config and register the provider with `ctx.forge`. */
export function apply(ctx: Context, config: Config): void {
  const resolved = validateConfig(config)
  const provider = makeGitCodeProvider(resolved)
  ctx.effect(() => {
    if (!hasToken(resolved)) {
      ctx.logger?.('forge-gitcode')?.info?.('no GitCode token in %s; reading public repositories only', resolved.tokenEnv)
    }
    // `inject: ['forge']` guarantees the registry is mounted before apply runs.
    // One narrow cast: cordis installs the registry on the context at runtime and
    // the cordis `Context` type does not declare it (measurement: without
    // `inject` the read throws `cannot get property "forge" without inject`).
    const registry = (ctx as unknown as { forge: { register(provider: unknown): () => Promise<void> } }).forge
    return registry.register(provider)
  }, 'forge-gitcode:register')
}
