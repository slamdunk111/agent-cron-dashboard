/**
 * Identity discovery for the community watch (P2, plan §3.1).
 *
 * Each platform identity comes from the frozen config (`identities[]`). GitHub
 * fills `username` from `gh api user` when the row leaves it out; GitCode
 * cannot discover its user without a token (api/v5 `GET /user` answers
 * `403 no scopes:read_user` anonymously, measured 2026-11-08T13:29:14+08:00),
 * so the token only *checks* the configured name (plan D5).
 *
 * Nothing here throws: every failure becomes a {@link PlatformIdentity} whose
 * `state` says what is wrong, so seeding names the degradation instead of
 * silently skipping a platform (plan constraint 6).
 */
import type { IdentityConfig } from '../config-validate.ts'

/** Platforms this service knows. */
export type Platform = 'github' | 'gitcode'

/** Outcome of resolving one platform's identity. */
export interface PlatformIdentity {
  readonly platform: Platform
  /** Account the workbench acts as. */
  readonly login: string | undefined
  /** `up`: usable; `degraded`: usable with a caveat; `down`: unusable. */
  readonly state: 'up' | 'degraded' | 'down'
  /** Cause when not `up`, or the caveat when `degraded`. */
  readonly message: string | null
  /** ISO 8601 of the probe. */
  readonly checkedAt: string
  /** Environment variable NAME holding the platform token (never the token). */
  readonly tokenEnv: string | undefined
}

/** Runs `gh` with an argument vector and resolves to its stdout. */
export type GhRunner = (args: readonly string[]) => Promise<string>

/** One GET result. */
export interface HttpResult {
  readonly status: number
  readonly text: string
}

/** HTTP transport, injectable so tests never touch the network. */
export interface IdentityTransport {
  get(url: string, headers: Readonly<Record<string, string>>): Promise<HttpResult>
}

/** Options of {@link resolveIdentities}. */
export interface IdentityOptions {
  readonly identities: readonly IdentityConfig[]
  /** Environment holding the token variables (`tokenEnv` names a variable, never a value). */
  readonly env: Readonly<Record<string, string | undefined>>
  readonly gh?: GhRunner
  readonly transport?: IdentityTransport
  readonly now?: () => Date
  /** GitCode web host; the api/v5 root is derived from it. */
  readonly gitcodeHost?: string
  /** Called for every user-facing line; the caller injects redaction. */
  readonly log?: (line: string) => void
}

const TOKEN_REFUSED_PREFIX = 'GitCode /user refused:'
const NO_TOKEN_PREFIX = 'no token in '

/** Default `gh` runner: spawn `gh`, never a shell. */
export function spawnGh(args: readonly string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    void (async () => {
      const { spawn } = await import('node:child_process')
      const { existsSync } = await import('node:fs')
      const { homedir } = await import('node:os')
      const { resolve } = await import('node:path')
      // dsh profiles may run with a PATH that lacks ~/.local/bin.
      const local = resolve(homedir(), '.local', 'bin', 'gh')
      const binary = existsSync(local) ? local : 'gh'
      const child = spawn(binary, [...args], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 })
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

/** Default GitCode transport: one plain GET with a deadline, redirects refused. */
export function fetchTransport(): IdentityTransport {
  return {
    async get(url, headers) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 15_000)
      if (timer.unref !== undefined) timer.unref()
      try {
        const response = await fetch(url, { method: 'GET', headers, signal: controller.signal, redirect: 'manual' })
        return { status: response.status, text: await response.text() }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

/** Read the token named by `tokenEnv`; undefined when unset or empty. */
export function tokenOf(env: Readonly<Record<string, string | undefined>>, tokenEnv: string | undefined): string | undefined {
  if (tokenEnv === undefined) return undefined
  const value = env[tokenEnv]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Replace every occurrence of each secret with `***`; empty secrets are ignored. */
export function redact(line: string, secrets: readonly (string | undefined)[]): string {
  let out = line
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length === 0) continue
    out = out.split(secret).join('***')
  }
  return out
}

/** Pull `login` out of a GitCode `/user` body. */
function gitcodeLogin(text: string): string | undefined {
  try {
    const body = JSON.parse(text) as { login?: unknown; username?: unknown }
    if (typeof body.login === 'string' && body.login.length > 0) return body.login
    if (typeof body.username === 'string' && body.username.length > 0) return body.username
    return undefined
  } catch {
    return undefined
  }
}

/** Host's own error text, prefixed with the status. */
function errorMessage(status: number, text: string): string {
  try {
    const body = JSON.parse(text) as { error_message?: unknown }
    if (typeof body.error_message === 'string') return `HTTP ${status} ${body.error_message}`
  } catch {
    // Not JSON: fall through to the raw text.
  }
  return `HTTP ${status} ${text.slice(0, 120)}`
}

async function resolveGithub(
  identity: IdentityConfig | undefined,
  options: { env: Readonly<Record<string, string | undefined>>; gh: GhRunner; now: () => Date },
): Promise<PlatformIdentity> {
  const checkedAt = options.now().toISOString()
  if (identity === undefined) {
    return {
      platform: 'github',
      login: undefined,
      state: 'down',
      message: 'no github entry in identities[]; nothing to watch',
      checkedAt,
      tokenEnv: undefined,
    }
  }
  if (identity.username !== undefined && identity.username.length > 0) {
    return { platform: 'github', login: identity.username, state: 'up', message: null, checkedAt, tokenEnv: identity.tokenEnv }
  }
  try {
    const login = (await options.gh(['api', 'user', '--jq', '.login'])).trim()
    if (login.length === 0) {
      return { platform: 'github', login: undefined, state: 'down', message: 'gh api user returned an empty login', checkedAt, tokenEnv: identity.tokenEnv }
    }
    return { platform: 'github', login, state: 'up', message: null, checkedAt, tokenEnv: identity.tokenEnv }
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error)
    return { platform: 'github', login: undefined, state: 'down', message: `gh CLI unavailable or signed out: ${cause}`, checkedAt, tokenEnv: identity.tokenEnv }
  }
}

async function resolveGitcode(
  identity: IdentityConfig | undefined,
  options: { env: Readonly<Record<string, string | undefined>>; now: () => Date; transport: IdentityTransport; host: string },
): Promise<PlatformIdentity> {
  const checkedAt = options.now().toISOString()
  if (identity === undefined) {
    return { platform: 'gitcode', login: undefined, state: 'down', message: 'no gitcode entry in identities[]', checkedAt, tokenEnv: undefined }
  }
  const configured = identity.username
  if (configured === undefined || configured.length === 0) {
    return { platform: 'gitcode', login: undefined, state: 'down', message: 'gitcode identity has no configured username', checkedAt, tokenEnv: identity.tokenEnv }
  }
  const token = tokenOf(options.env, identity.tokenEnv)
  if (token === undefined) {
    return {
      platform: 'gitcode',
      login: configured,
      state: 'down',
      message: `${NO_TOKEN_PREFIX}${identity.tokenEnv ?? 'tokenEnv'}; GitCode /user answers 403 no scopes:read_user without credentials`,
      checkedAt,
      tokenEnv: identity.tokenEnv,
    }
  }
  const url = `https://${options.host}/api/v5/user`
  let response: HttpResult
  try {
    response = await options.transport.get(url, { Accept: 'application/json', 'private-token': token })
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error)
    return { platform: 'gitcode', login: configured, state: 'down', message: `GitCode /user request failed: ${cause}`, checkedAt, tokenEnv: identity.tokenEnv }
  }
  if (response.status !== 200) {
    const refusal = `${TOKEN_REFUSED_PREFIX} ${errorMessage(response.status, response.text)}`
    return { platform: 'gitcode', login: configured, state: 'down', message: refusal, checkedAt, tokenEnv: identity.tokenEnv }
  }
  const discovered = gitcodeLogin(response.text)
  if (discovered === undefined) {
    return { platform: 'gitcode', login: configured, state: 'down', message: 'GitCode /user returned no login field', checkedAt, tokenEnv: identity.tokenEnv }
  }
  if (discovered !== configured) {
    return {
      platform: 'gitcode',
      login: configured,
      state: 'degraded',
      message: `token belongs to ${discovered}, configured username is ${configured}; seeding filters by the configured name`,
      checkedAt,
      tokenEnv: identity.tokenEnv,
    }
  }
  return { platform: 'gitcode', login: configured, state: 'up', message: null, checkedAt, tokenEnv: identity.tokenEnv }
}

/**
 * Resolve both platform identities.
 * @param options - row identities, environment, injectable runners.
 * @returns GitHub first, GitCode second; each entry names its own degradation.
 */
export async function resolveIdentities(options: IdentityOptions): Promise<PlatformIdentity[]> {
  const now = options.now ?? (() => new Date())
  const gh = options.gh ?? spawnGh
  const transport = options.transport ?? fetchTransport()
  const host = options.gitcodeHost ?? 'gitcode.com'
  const github = options.identities.find((entry) => entry.platform === 'github')
  const gitcode = options.identities.find((entry) => entry.platform === 'gitcode')
  const identities = [
    await resolveGithub(github, { env: options.env, gh, now }),
    await resolveGitcode(gitcode, { env: options.env, transport, host, now }),
  ]
  // Every line leaves through the one exit, already redacted: the GitCode host
  // can echo a token slot back (the offline stand-in for G2 does exactly that).
  const tokens = [tokenOf(options.env, github?.tokenEnv), tokenOf(options.env, gitcode?.tokenEnv)]
  const longTokens = tokens.filter((value): value is string => typeof value === 'string' && value.length >= 12)
  const log =
    options.log ??
    ((line: string) => console.log(line.includes('refused') || line.includes('invalid token') ? redact(line, longTokens) : line))
  for (const identity of identities) {
    log(`identity ${identity.platform} state=${identity.state} message="${identity.message ?? ''}"`)
  }
  return identities
}

/**
 * Cursor rows recording identity discovery (`workbench_cursors`, key `identity:<platform>`).
 * @param identities - outcomes of {@link resolveIdentities}.
 * @returns `[key, token]` pairs holding no credential.
 */
export function identityCursors(identities: readonly PlatformIdentity[]): Array<[string, string]> {
  return identities.map((identity) => [
    `identity:${identity.platform}`,
    JSON.stringify({ login: identity.login ?? null, state: identity.state }),
  ])
}

/**
 * The one login seeding and the oracle both read (plan §3.1 rule 4).
 * @param identities - resolved identities.
 * @param platform - which platform to ask for.
 * @returns the login, or undefined when the platform is unusable.
 */
export function effectiveLogin(identities: readonly PlatformIdentity[], platform: Platform): string | undefined {
  const identity = identities.find((entry) => entry.platform === platform)
  return identity !== undefined && identity.state !== 'down' ? identity.login : undefined
}

/** Message prefix the GitCode `/user` refusal carries (G2 asserts this line). */
export const TOKEN_REFUSAL_MESSAGE_PREFIX = TOKEN_REFUSED_PREFIX
