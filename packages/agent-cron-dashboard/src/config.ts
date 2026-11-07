/**
 * Frozen config module: `Config` (schemastery, validated by dsh at
 * activation) plus the typed layer (`validateWorkbenchConfig`) that mirrors
 * `../../contracts/config.schema.json`.
 *
 * Kept byte-for-byte transportable: it holds NO cross-package import
 * (`../../../contracts`) because dsh copies the linked package directory into
 * the profile's node_modules, which would break every `../` hop above it.
 */
import z from '@deepseek-ai/schemastery'
import {
  validateWorkbenchConfig,
  type WorkbenchConfig,
} from './config-validate.ts'

export type { WorkbenchConfig } from './config-validate.ts'
export { validateWorkbenchConfig, ConfigValidationError, validateTokenEnv } from './config-validate.ts'

/** Token env name: environment variable NAME only, never a credential literal. */
const TOKEN_ENV_RE = /^[A-Z][A-Z0-9_]*$/
/** Values shaped like a real credential are rejected even inside `tokenEnv`. */
const SECRET_LITERAL_RE = /(?:ghp_|github_pat_|glpat-|sk-|xox[baprs]-|-----BEGIN [A-Z ]*PRIVATE KEY-----)/

/** Validate one tokenEnv value of a decoded row (environment variable NAME only). */
export function checkTokenEnv(value: string, path: string): string {
  if (!TOKEN_ENV_RE.test(value)) throw new Error(`${path}: tokenEnv must be an environment variable NAME (A-Z0-9_ only)`)
  if (SECRET_LITERAL_RE.test(value)) throw new Error(`${path}: tokenEnv looks like a credential literal; only environment variable names are accepted`)
  return value
}

const identity = z.object({
  platform: z.union(['github', 'gitcode'] as const).required(),
  username: z.string(),
  tokenEnv: z.string(),
})

const fleetSsh = z.object({
  host: z.string().required(),
  dbPath: z.string(),
  errorsLog: z.string(),
  sshOptions: z.array(z.string()),
})

const fleetSource = z.object({
  id: z.string().required(),
  kind: z.union(['hermes-ssh', 'jiuwenswarm-local', 'ssh-sqlite'] as const).required(),
  label: z.string(),
  enabled: z.boolean().default(true),
  ssh: fleetSsh,
  paths: z.object({ state: z.string() }),
  query: z.string(),
})

/**
 * Row config schema of the `workbench` plugin.
 *
 * Schemastery yields the fast runtime gate dsh applies to the YAML row; the
 * finer rules (credential literals, read-only queries, cross-field
 * requirements) run in the typed layer on every `apply`.
 */
export const Config = z.object({
  identities: z.array(identity).default([]),
  watch: z
    .object({
      repos: z.array(z.string()).default([]),
      issuePollIntervalMs: z.natural().min(60000).default(300000),
    })
    .default({}),
  fleet: z.array(fleetSource).default([]),
  poll: z
    .object({
      fleetIntervalMs: z.natural().min(60000).default(300000),
      backoffMaxMs: z.natural().min(600000).default(3600000),
    })
    .default({}),
  analysis: z
    .object({
      llm: z.object({ enabled: z.boolean().default(true) }).default({}),
      greenRunsToVerify: z.natural().min(1).max(20).default(3),
      retentionDays: z.natural().min(7).max(3650).default(90),
    })
    .default({}),
  notify: z
    .object({
      actionCards: z.boolean().default(true),
      digest: z
        .object({
          enabled: z.boolean().default(true),
          cron: z.string().default('0 9 * * *'),
        })
        .default({}),
    })
    .default({}),
})

/** Normalize a schemastery-decoded row: `identity.tokenEnv` is re-checked here. */
export function resolveConfig(raw: unknown): WorkbenchConfig {
  const resolved = validateWorkbenchConfig(raw ?? {})
  resolved.identities.forEach((entry, index) => {
    if (entry.tokenEnv !== undefined) checkTokenEnv(entry.tokenEnv, `$.identities[${index}].tokenEnv`)
  })
  return resolved
}
