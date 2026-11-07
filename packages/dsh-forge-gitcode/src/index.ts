/**
 * Host half of `dsh-forge-gitcode` — the GitCode (api/v5) provider for the
 * dsh experimental forge registry.
 *
 * P0 scope: package skeleton + manifest row registration only. P1 fills in
 * the provider itself (endpoint probe -> `../docs/gitcode-v5-diff.md` ->
 * implementation -> contract tests), per `plan-of-plans/P1-forge-gitcode.md`.
 *
 * The provider is a plain object (no dsh service), so this module has exactly
 * one runtime dependency (`cordis`, satisfied by the dsh host) which keeps the
 * package publishable as a standalone forge provider.
 */
import type { Context } from '@deepseek-ai/cordis'

/**
 * Token env name rule. The same rule lives in `contracts/config-validate.ts`
 * validateTokenEnv (mirrored into the main bundle by `pnpm sync:contracts`); a
 * note in ADR P0-4 records why a package-local copy is kept here.
 */
const TOKEN_ENV_RE = /^[A-Z][A-Z0-9_]*$/

export interface Config {
  /** Name of the environment variable that holds the GitCode access token (default `GITCODE_TOKEN`). */
  tokenEnv?: string
  /** GitCode web host; `api/v5` calls are derived from it. */
  host?: string
}

/** Defaults applied before validation; mirrors `cordis.patch.yml`. */
export const DEFAULT_CONFIG: Required<Config> = {
  tokenEnv: 'GITCODE_TOKEN',
  host: 'gitcode.com',
}

/**
 * Validate a row config.
 *
 * Same rule as `contracts/config-validate.ts` validateTokenEnv: the value is an
 * environment variable NAME (3..128 upper-case characters). Credential literals
 * cannot pass this pattern, so no separate blacklist is needed.
 * @throws Error when `tokenEnv` is not an environment variable name.
 */
export function validateConfig(config: Config): Required<Config> {
  const merged = { ...DEFAULT_CONFIG, ...config }
  if (typeof merged.tokenEnv !== 'string' || merged.tokenEnv.length < 3 || merged.tokenEnv.length > 128 || !TOKEN_ENV_RE.test(merged.tokenEnv)) {
    throw new Error('tokenEnv must be an environment variable NAME (A-Z0-9_ only, 3..128 characters)')
  }
  if (typeof merged.host !== 'string' || merged.host.length === 0) throw new Error('host must be a non-empty string')
  return merged
}

/** Capability table placeholder; P1 replaces it with the measured v5 results. */
export const P0_CAPABILITIES = [
  { capability: 'repositoryFromRemote', implemented: false, note: 'P1' },
  { capability: 'changeRequestFromUrl', implemented: false, note: 'P1' },
  { capability: 'fetch', implemented: false, note: 'P1' },
] as const

/** Whether a token is present in the environment (never returns the token itself). */
export function hasToken(config: Required<Config>, env: NodeJS.ProcessEnv = process.env): boolean {
  return typeof env?.[config.tokenEnv] === 'string' && (env[config.tokenEnv] as string).length > 0
}

/** Cordis entry: validate the row config; P1 registers the provider with `ctx.forge` here. */
export function apply(ctx: Context, config: Config): void {
  const resolved = validateConfig(config)
  ctx.effect(() => {
    if (hasToken(resolved)) ctx.logger?.('forge-gitcode')?.info?.('GitCode token present in env %s', resolved.tokenEnv)
    return () => undefined
  }, 'forge-gitcode:config')
}
