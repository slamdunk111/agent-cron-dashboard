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

/** Normalize a schemastery-decoded row: the typed validator applies the defaults and the rules. */
export function resolveConfig(raw: unknown): WorkbenchConfig {
  return validateWorkbenchConfig(raw ?? {})
}
