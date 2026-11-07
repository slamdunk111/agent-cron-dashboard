/**
 * Host half of the `agent-cron-dashboard` bundle.
 *
 * P0 delivers the smallest closed loop the later plans build on:
 * config validation (frozen schema in `../../contracts/config.schema.json`),
 * the six storage domains of design §8, and an empty `WorkbenchService`
 * that later plans (P2-P7) fill in node by node.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { domainTable, defineDomain } from '@deepseek-ai/dsh-storage-domain'
import z from 'zod'
import { validateWorkbenchConfig, type WorkbenchConfig } from '../../../contracts/config-validate.ts'

/** ISO 8601 timestamp string; stored verbatim, validated on read. */
const iso = z.string().min(19)

/** One machine evidence pair. */
const changeEvidence = z.object({
  field: z.string().min(1),
  before: z.unknown(),
  after: z.unknown(),
})

/** One graded change event (contracts/events.ts ChangeEvent). */
const changeEvent = z.object({
  level: z.enum(['high', 'medium']),
  kind: z.string().min(1),
  subject: z.object({
    scope: z.enum(['community', 'fleet']),
    key: z.string().min(1),
    label: z.string(),
    sourceId: z.string().optional(),
  }),
  summary: z.string(),
  evidence: z.array(changeEvidence),
  at: iso,
})

/** PR snapshot (contracts/records.ts PrSnapshot). */
const prSnapshot = z.object({
  platform: z.enum(['github', 'gitcode']),
  owner: z.string(),
  repo: z.string(),
  number: z.number().int().positive(),
  title: z.string(),
  state: z.enum(['open', 'closed', 'merged']),
  draft: z.boolean(),
  mergeability: z.enum(['mergeable', 'conflicting', 'unknown']),
  reviewDecision: z.enum(['approved', 'changes-requested', 'review-required', 'none']),
  checksRollup: z.enum(['none', 'pending', 'success', 'failure']),
  headSha: z.string(),
  updatedAt: iso,
  firstSeenAt: iso,
  lastSeenAt: iso,
  events: z.array(changeEvent).max(50),
})

/** Issue snapshot (contracts/records.ts IssueSnapshot). */
const issueSnapshot = z.object({
  platform: z.enum(['github', 'gitcode']),
  owner: z.string(),
  repo: z.string(),
  number: z.number().int().positive(),
  title: z.string(),
  state: z.enum(['open', 'closed']),
  labels: z.array(z.string()),
  assignees: z.array(z.string()),
  comments: z.number().int().nonnegative(),
  updatedAt: iso,
  lastCommentBy: z.string().nullable(),
  lastCommentAt: iso.nullable(),
  firstSeenAt: iso,
  lastSeenAt: iso,
  events: z.array(changeEvent).max(50),
})

/** Fleet job record (contracts/records.ts FleetJobRecord). */
const fleetJobRecord = z.object({
  sourceId: z.string().min(1),
  jobId: z.string().min(1),
  name: z.string(),
  schedule: z.string().nullable(),
  script: z.string().nullable(),
  lastRunAt: iso.nullable(),
  lastStatus: z.enum(['ok', 'failed', 'timeout', 'running']).nullable(),
  greenStreak: z.number().int().nonnegative(),
  collectedAt: iso,
})

/** Source health (contracts/records.ts SourceHealth). */
const sourceHealth = z.object({
  sourceId: z.string().min(1),
  state: z.enum(['up', 'down', 'degraded', 'disabled']),
  latencyMs: z.number().nonnegative().nullable(),
  checkedAt: iso,
  message: z.string().nullable(),
  consecutiveFailures: z.number().int().nonnegative(),
})

/** Error record (contracts/records.ts IssueRecord). */
const issueRecord = z.object({
  recordId: z.string().min(1),
  signature: z.string().min(1),
  sourceId: z.string().min(1),
  jobId: z.string().nullable(),
  state: z.enum(['open', 'analyzed', 'fix-applied', 'verified-resolved', 'closed-wontfix', 'reopened']),
  severity: z.string(),
  count: z.number().int().nonnegative(),
  firstSeen: iso,
  lastSeen: iso,
  samples: z.array(
    z.object({ occurredAt: iso, severity: z.string(), message: z.string() }),
  ),
  analysis: z.object({
    state: z.enum(['pending', 'running', 'done', 'failed']),
    rootCauseHypothesis: z.string().nullable(),
    impact: z.string().nullable(),
    suggestedFix: z.array(z.string()),
    confidence: z.number().min(0).max(1).nullable(),
    needMoreInfo: z.array(z.string()),
    analyzedAt: iso.nullable(),
    model: z.string().nullable(),
  }),
  resolution: z.array(
    z.object({
      kind: z.enum(['fix-applied', 'green', 'reopened', 'wontfix']),
      at: iso,
      by: z.string(),
      note: z.string().nullable(),
    }),
  ),
  verifiedAt: iso.nullable(),
})

/** Fingerprint index (contracts/records.ts FingerprintRecord). */
const fingerprintRecord = z.object({
  signature: z.string().min(1),
  recordId: z.string().min(1),
  count: z.number().int().nonnegative(),
  lastSeen: iso,
})

/** Incremental cursor (contracts/records.ts CursorRecord). */
const cursorRecord = z.object({
  token: z.string(),
  updatedAt: iso,
})

/**
 * Storage domain of PR snapshots, key `<platform>/<owner>/<repo>/<number>`.
 *
 * Domain names must match `^[a-z][a-z0-9_]*$` (dsh 0.2.2-rc.1 `defineDomain`),
 * so design §8's dotted keyspace (`workbench.snapshot.pr`) is written with
 * underscores here: `workbench_snapshot_pr`.
 */
export const prDomain = defineDomain({
  name: 'workbench_snapshot_pr',
  version: 1,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: { snapshots: domainTable<string, z.infer<typeof prSnapshot>>(prSnapshot) },
})

/** Storage domain of issue snapshots, same key shape as {@link prDomain}. */
export const issueDomain = defineDomain({
  name: 'workbench_snapshot_issue',
  version: 1,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: { snapshots: domainTable<string, z.infer<typeof issueSnapshot>>(issueSnapshot) },
})

/** Storage domain of fleet job records, key `<sourceId>/<jobId>`. */
export const fleetJobsDomain = defineDomain({
  name: 'workbench_fleet_jobs',
  version: 1,
  tables: { jobs: domainTable<string, z.infer<typeof fleetJobRecord>>(fleetJobRecord) },
})

/** Storage domain of error records (issue ledger), key `<recordId>`. */
export const fleetErrorsDomain = defineDomain({
  name: 'workbench_fleet_errors',
  version: 1,
  layout: 'per-record',
  tables: { records: domainTable<string, z.infer<typeof issueRecord>>(issueRecord) },
})

/** Storage domain of fingerprints, key `<signature>`. */
export const fingerprintsDomain = defineDomain({
  name: 'workbench_fingerprints',
  version: 1,
  layout: 'per-record',
  tables: { fingerprints: domainTable<string, z.infer<typeof fingerprintRecord>>(fingerprintRecord) },
})

/** Storage domain of incremental cursors, key `<sourceId>:<stream>`. */
export const cursorsDomain = defineDomain({
  name: 'workbench_cursors',
  version: 1,
  tables: { cursors: domainTable<string, z.infer<typeof cursorRecord>>(cursorRecord) },
})

/** Source health snapshots, key `<sourceId>` (fleet health panel of design §5.3). */
export const sourceHealthDomain = defineDomain({
  name: 'workbench_fleet_health',
  version: 1,
  tables: { health: domainTable<string, z.infer<typeof sourceHealth>>(sourceHealth) },
})

/** Every domain the workbench owns, in declaration order. */
export const DOMAINS = [
  prDomain,
  issueDomain,
  fleetJobsDomain,
  fleetErrorsDomain,
  fingerprintsDomain,
  cursorsDomain,
  sourceHealthDomain,
] as const

/** Raw row config accepted by {@link apply}; validated by `contracts/config-validate.ts`. */
export type Config = Partial<WorkbenchConfig>

/**
 * Workbench service: the handle later plans inject into.
 *
 * P0 only opens the storage domains and exposes the resolved config. P2
 * attaches `snapshotPr`/`snapshotIssue`, P3 `issueWatch`, P4 `changeEngine`,
 * P5 `fleetWatch`, P6 `errorPipeline`, P7 reads them through the client.
 */
export class WorkbenchService extends Service {
  static name = 'workbench'
  /** Resolved (defaults applied) configuration. */
  readonly config: WorkbenchConfig
  /** Open storage domains keyed by domain name. */
  readonly domains: Readonly<Record<string, unknown>> = {}
  /** Startup time, used by `workbench_status`. */
  readonly startedAt = new Date().toISOString()

  constructor(ctx: Context, raw: Config) {
    super(ctx, 'workbench', true)
    this.config = validateWorkbenchConfig(raw ?? {})
  }

  /**
   * Open every declared storage domain on the storage facility.
   * @throws DomainError when a backend route is missing or a stored record is invalid.
   */
  async openDomains(): Promise<void> {
    for (const spec of DOMAINS) {
      const domain = await this.ctx.storageDomain.open(spec)
      ;(this.domains as Record<string, unknown>)[spec.name] = domain
      this.ctx.effect(() => () => domain.close(), `workbench:domain:${spec.name}`)
    }
  }

  /** Names of the storage domains this workbench opened. */
  domainNames(): string[] {
    return Object.keys(this.domains)
  }
}

/** Cordis entry of the bundle's host row. */
export function apply(ctx: Context, raw: Config = {}): void {
  // Validated once here so activation fails loud; the service re-validates to
  // retain the resolved object for consumers.
  const resolved = validateWorkbenchConfig(raw)
  ctx.plugin(WorkbenchService, raw)
  ctx.effect(() => {
    ctx.logger?.('workbench')?.info?.('workbench ready: %d fleet source(s), digest cron %s', resolved.fleet.length, resolved.notify.digest.cron)
    return () => undefined
  }, 'workbench:announce')
}
