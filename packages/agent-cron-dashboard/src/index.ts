/**
 * Host half of the `agent-cron-dashboard` bundle.
 *
 * P0 delivers the smallest closed loop the later plans build on: config
 * validation (frozen schema in `contracts/config.schema.json`), the **seven**
 * storage domains of design §8 plus the fleet health domain of §5.3 (a
 * declared deviation from the plan's "six domains", see ADR P0-2), and an
 * empty `WorkbenchService` that later plans (P2-P7) fill in node by node.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { defineDomain, domainTable, type DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import z from 'zod'
import { CHANGE_LEVELS } from '../../../contracts/events.ts'
import type { ChangeEvent } from '../../../contracts/events.ts'
import type { IssueRecord, IssueSnapshot, PrSnapshot } from '../../../contracts/records.ts'
import { Config as RowConfig, resolveConfig, type WorkbenchConfig } from './config.ts'

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
  kind: z.enum(Object.keys(CHANGE_LEVELS) as [keyof typeof CHANGE_LEVELS, ...(keyof typeof CHANGE_LEVELS)[]]),
  subject: z.object({
    scope: z.enum(['community', 'fleet']),
    key: z.string().min(1),
    label: z.string(),
    sourceId: z.string().optional(),
  }),
  summary: z.string(),
  evidence: z.array(changeEvidence),
  at: iso,
}) satisfies z.ZodType<ChangeEvent>

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
}) satisfies z.ZodType<PrSnapshot>

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
}) satisfies z.ZodType<IssueSnapshot>

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
}) satisfies z.ZodType<IssueRecord>

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

/** Row config accepted by {@link apply}; dsh validates it with {@link RowConfig}. */
export type Config = Partial<WorkbenchConfig>

/** Plugin row name (dsh expects a `name` export; the loader keeps the row id). */
export const name = 'workbench'

/**
 * Services this row reads: `storageDomain`, served by the mounted
 * `@deepseek-ai/dsh-storage-domain` form (composed by the `dsh-base` stack).
 * The declaration satisfies dsh's plugin check; the read itself goes through
 * `ctx.get('storageDomain')`, which works in both the composer and a bare
 * `Context` (probe results in ADR P0-6, `contracts/adr/P0-inject-and-ctx-get.md`).
 */
export const inject = ['storageDomain']

/** Schemastery row schema so dsh validates activation. */
export { RowConfig as Config }

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
  /** Why storage domains failed to open (inspect-visible), or null while healthy. */
  domainError: string | null = null

  constructor(ctx: Context, raw: Config) {
    super(ctx, 'workbench')
    this.config = resolveConfig(raw)
    // Published for read-only inspect reads.
    workbenchService = this
    // Domains open as an effect of this row, so they close when the row
    // unmounts (dsh's storage facility would close them on unmount anyway).
    ctx.effect(() => {
      let disposed = false
      let retry: ReturnType<typeof setInterval> | undefined
      // Every open attempt (first one and each retry) is tracked so disposal
      // can wait for an in-flight open to settle before closing whatever it
      // opened; otherwise a mid-open unmount leaks the domains opened after
      // the disposer already took its snapshot.
      const opened = () => {
        if (disposed) return
        this.domainError = null
        // Also printed to stdout: the web profile keeps only diagnostics logs
        // under ~/.dsh/logs, so acceptance checks need a visible line.
        const line = 'workbench: storage domains opened (' + this.domainNames().length + ')'
        ctx.logger?.('workbench')?.info?.(line)
        console.log(line)
      }
      const attempts: Promise<void>[] = []
      const attempt = () => {
        const pending = this.openDomains()
        attempts.push(pending)
        void pending
          .then(() => {
            if (disposed) return
            if (retry !== undefined) clearInterval(retry)
            opened()
          })
          .catch((error: unknown) => {
            if (disposed) return
            this.domainError = String(error instanceof Error ? error.message : error)
            if (retry === undefined) {
              // The domain facility may still be mounting when this row
              // activates (`storage-domain` injects the `storage` hub), so
              // absence is retried rather than treated as permanent.
              retry = setInterval(() => {
                if (disposed) {
                  if (retry !== undefined) clearInterval(retry)
                  return
                }
                attempt()
              }, 1000)
            }
          })
      }
      attempt()
      return async () => {
        disposed = true
        if (retry !== undefined) clearInterval(retry)
        // Let every open attempt still in flight finish (a retry may be revisiting
        // domains the first attempt already opened), then close what the row holds.
        await Promise.allSettled(attempts)
        // Domain handles are stored untyped in `domains`; the only member used
        // here is `close`, and storage-domain guarantees it on every handle.
        await Promise.allSettled(
          Object.values(this.domains).map((domain) => (domain as { close(): Promise<void> }).close()),
        )
      }
    }, 'workbench:domains')
  }

  /**
   * Open every declared storage domain on the storage facility.
   * @throws DomainError when a backend route is missing or a stored record is invalid.
   */
  async openDomains(): Promise<void> {
    // The `storageDomain` form is mounted by the composed `storage-domain` row
    // under the profile's `storage` hub. Read it through `ctx.get`, which
    // resolves from the plugin's committed services and does not trip the
    // proxy's "without inject" guard (measured: the bare property read fails).
    // `ctx.get` is untyped (any); the value is narrowed to the facility type here
    // and guarded below.
    const facility = this.ctx.get?.('storageDomain') as DomainFacility | undefined
    if (facility === undefined) throw new Error('workbench: storageDomain facility is not mounted in this profile')
    for (const spec of DOMAINS) {
      if ((this.domains as Record<string, unknown>)[spec.name] !== undefined) continue
      const domain = await facility.open(spec)
      ;(this.domains as Record<string, unknown>)[spec.name] = domain
    }
  }

  /** Names of the storage domains this workbench opened. */
  domainNames(): string[] {
    return Object.keys(this.domains)
  }
}

/**
 * Read-only inspect provider of the workbench row.
 *
 * The row registers itself with the process-wide `cordisInspect` registry
 * (dsh 0.2.2-rc.1 `CordisInspectRegistryService`) so the model-facing
 * `cordis_inspect_query` tool can confirm the configuration row and every
 * storage domain that is actually open, without a browser page. Registration
 * is skipped when no inspect registry is mounted (e.g. `--dump-config`).
 */
export const inspectProvider = {
  manifest: {
    id: 'workbench-domains',
    description: 'Reports the workbench configuration row and the storage domains currently open on this host.',
    methods: [
      {
        name: 'list',
        description: 'List the resolved workbench config summary and the names of every open storage domain.',
        inputSchema: { type: 'object', additionalProperties: false, properties: {} },
        outputSchema: {
          type: 'object',
          properties: {
            startedAt: { type: 'string' },
            domains: { type: 'array', items: { type: 'string' } },
            fleetSources: { type: 'array', items: { type: 'string' } },
            digestCron: { type: 'string' },
            domainError: { type: 'string', description: 'Empty string when storage domains opened cleanly.' },
          },
          required: ['startedAt', 'domains', 'fleetSources', 'digestCron', 'domainError'],
        },
      },
    ],
  },
  async query(method: string, _input: unknown, _context: unknown) {
    if (method !== 'list') throw new Error(`unknown method ${method}`)
    const service = workbenchService
    if (service === undefined) throw new Error('workbench service is not mounted')
    return {
      startedAt: service.startedAt,
      domains: service.domainNames(),
      fleetSources: service.config.fleet.map((source: { id: string }) => source.id),
      digestCron: service.config.notify.digest.cron,
      // The inspect schema language has no nullable type, so an empty string
      // encodes "domains opened cleanly".
      domainError: service.domainError ?? '',
    }
  },
}

/** The mounted service, published for inspect and smoke reads. */
let workbenchService: WorkbenchService | undefined

/**
 * Construct the row service the way dsh does (`new WorkbenchService(ctx, cfg)`),
 * including its domain-opening effect.
 * @param ctx - the host context the row is mounted on.
 * @param raw - the row's YAML config.
 */
export function makeWorkbenchService(ctx: Context, raw: Config): WorkbenchService {
  return new WorkbenchService(ctx, raw)
}

/** Read the mounted instance (read-only; used by the row-path test and inspect). */
export function getWorkbenchService(): WorkbenchService | undefined {
  return workbenchService
}

/** Publish or clear the inspect-visible instance (the smoke probe uses the setter). */
export function setWorkbenchService(service: WorkbenchService | undefined): void {
  workbenchService = service
}

/** Cordis entry of the bundle's host row. */
export function apply(ctx: Context, raw: Config = {}): void {
  // Validated before anything touches `ctx`, so a rejected row (credential
  // literal, write query, missing ssh block ...) fails activation loud.
  const resolved = resolveConfig(raw)
  // dsh constructs the service from this row context when the plugin mounts,
  // and publishes the instance through WorkbenchService's constructor.
  ctx.plugin(WorkbenchService, raw)
  ctx.effect(() => {
    const registry = ctx.get?.('cordisInspect') as
      | { register(registration: unknown): () => void }
      | undefined
    const unregister = registry?.register(inspectProvider)
    ctx.logger?.('workbench')?.info?.('workbench ready: %d fleet source(s), digest cron %s, inspect provider %s', resolved.fleet.length, resolved.notify.digest.cron, unregister === undefined ? 'skipped' : 'registered')
    return () => {
      unregister?.()
    }
  }, 'workbench:announce')
}
