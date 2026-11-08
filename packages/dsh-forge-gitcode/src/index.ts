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
import { countDiffLines, countFileLines, snapshotOf, type GitCodeFileJson, type GitCodePullJson } from './mapping.ts'
import { parseJson, request, type TransportFeatures } from './transport.ts'

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
  /** How many `files` pages to read for line counts; 0 disables the extra read. */
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
    { capability: 'fetch', implemented: true, note: null },
    { capability: 'fetchChecks', implemented: false, note: 'api/v5 has no check-runs/check list endpoint (404 x5); only mergeable_state.ci_state_passed' },
    { capability: 'findByHead', implemented: true, note: null },
    { capability: 'readiness', implemented: true, note: 'GET /api/v5/user; anonymous access answers 400 private-token required' },
    { capability: 'markReady', implemented: false, note: 'draft marking needs an authenticated PATCH probe (diff doc §4)' },
    { capability: 'merge', implemented: false, note: 'merge endpoint shape needs an authenticated probe (diff doc §4)' },
    { capability: 'diff', implemented: true, note: 'web /pull/{n}.diff (api .diff answers 400)' },
    { capability: 'fileText', implemented: true, note: 'contents?ref={commit} -> download_url on raw.gitcode.com' },
    { capability: 'fileUrl', implemented: true, note: null },
    { capability: 'submitReview', implemented: false, note: 'no reviews endpoint (404); inline comment shape needs an authenticated probe' },
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

  async function readPull(ref: ForgeChangeRequestRef, signal: AbortSignal): Promise<ChangeRequestSnapshot | ForgeFailure> {
    const gitcode = asGitCode(ref)
    const result = await request(`${apiBase(gitcode)}/pulls/${ref.number}`, transport, signal)
    if (!result.ok) return result.failure
    const parsed = parseJson(result.text)
    if (!parsed.ok) return parsed.failure
    const pull = parsed.value as GitCodePullJson
    const sizes = config.filesPageSize > 0 ? await readSizes(gitcode, signal) : undefined
    if (sizes !== undefined && 'code' in sizes) {
      // A missing `files` page degrades the counts, not the whole snapshot.
      return snapshotOf(pull, ref)
    }
    return snapshotOf(pull, ref, sizes)
  }

  async function readSizes(
    ref: GitCodeChangeRequestRef,
    signal: AbortSignal,
  ): Promise<{ additions: number; deletions: number } | ForgeFailure> {
    const all: GitCodeFileJson[] = []
    for (let page = 1; page <= 10; page += 1) {
      const result = await request(`${apiBase(ref)}/pulls/${ref.number}/files?per_page=${config.filesPageSize}&page=${page}`, transport, signal)
      if (!result.ok) return result.failure
      const parsed = parseJson(result.text)
      if (!parsed.ok) return parsed.failure
      const rows = parsed.value as GitCodeFileJson[]
      if (!Array.isArray(rows) || rows.length === 0) break
      all.push(...rows)
      if (rows.length < config.filesPageSize) break
    }
    return countFileLines(all)
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
      const result = await request(`https://${host}/api/v5/user`, transport, signal)
      if (result.ok) return { state: 'ready', message: null }
      if (result.failure.code === 'unauthenticated') {
        return { state: 'unauthenticated', message: 'set the env variable named by tokenEnv to a GitCode access token' }
      }
      return { state: 'unavailable', message: result.failure.message }
    },
    async diff(ref, signal) {
      const result = await request(diffUrl(asGitCode(ref)), transport, signal, 'text/plain')
      if (!result.ok) return result.failure
      return result.text
    },
    async fileText(ref, commit, path, signal) {
      const gitcode = asGitCode(ref)
      const result = await request(`${apiBase(gitcode)}/contents/${path.replace(/^\//, '')}?ref=${encodeURIComponent(commit)}`, transport, signal)
      if (!result.ok) return result.failure
      const parsed = parseJson(result.text)
      if (!parsed.ok) return parsed.failure
      const entry = parsed.value as { download_url?: string; content?: string; encoding?: string }
      if (typeof entry.download_url === 'string') {
        const raw = await request(entry.download_url, transport, signal, 'text/plain')
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
    // `forge` is injected by `@deepseek-ai/dsh-experimental-forge`; the registry
    // service is read the same way the workbench reads `storageDomain` (ADR P0-6).
    const forge = (ctx as unknown as { forge?: { register(provider: unknown): () => Promise<void> } }).forge
    if (forge === undefined) throw new Error('forge-gitcode: the forge registry is not mounted (add @deepseek-ai/dsh-experimental-forge)')
    return forge.register(provider)
  }, 'forge-gitcode:register')
}
