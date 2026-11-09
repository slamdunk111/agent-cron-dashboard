/**
 * Host half of the `agent-cron-dashboard` bundle.
 *
 * P0 delivers the smallest closed loop the later plans build on: config
 * validation (frozen schema in `contracts/config.schema.json`), the **seven**
 * storage domains of design §8 plus the fleet health domain of §5.3 (a
 * declared deviation from the plan's "six domains", see ADR P0-2), and an
 * empty `WorkbenchService` that later plans (P2-P7) fill in node by node.
 */
import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import { promises as fsPromises } from 'node:fs'
import { Context, Service } from '@deepseek-ai/cordis'
import { defineDomain, domainTable, type DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import z from 'zod'
import { CHANGE_LEVELS } from '../../../contracts/events.ts'
import type { ChangeEvent } from '../../../contracts/events.ts'
import type { FleetSource } from '../../../contracts/fleet-source.ts'
import type { FleetSourceConfigResolved } from '../../../contracts/config-validate.ts'
import type { IssueRecord, IssueSnapshot, PrSnapshot } from '../../../contracts/records.ts'
import { Config as RowConfig, resolveConfig, type WorkbenchConfig } from './config.ts'
import { ChangeEngine, type CursorTable, type EventsTable, type IssueSnapshotTable, type PrSnapshotTable } from './core/change-engine.ts'
import { DigestController, type SchedulePort } from './core/digest.ts'
import { NotifyService } from './core/notify.ts'
import { NOTIFY_ACTION, notifyKind, skillText } from './core/notify-skill.ts'
import { STATUS_DESCRIPTION, STATUS_SCOPES, STATUS_TOOL, buildStatus } from './core/tools-status.ts'
import { FleetWatchService, type FleetWatchTables } from './fleet/fleet-watch.ts'
import { HermesSshAdapter } from './fleet/hermes-ssh.ts'
import { JiuwenswarmLocalAdapter, type LocalFiles, type LocalServiceProbe } from './fleet/jiuwenswarm-local.ts'
import { GenericSshSqliteAdapter } from './fleet/generic-ssh-sqlite.ts'
import { makeRunRemote } from './fleet/ssh-exec.ts'
import { RUN_EVENTS_SQL, ErrorPipeline, pullRunEventErrors, type PipelineTables } from './fleet/error-pipeline.ts'
import { decodeEventKey, eventKeyOf } from './fleet/event-key.ts'
import { ErrorAnalyzer, type AnalysisChunk, type AnalysisPort, type AnalysisRequest } from './fleet/analyzer.ts'
import { ErrorResolver } from './fleet/resolver.ts'
import { ERRORS_DESCRIPTION, RESOLVE_DESCRIPTION, RESOLVE_TOOL, ERRORS_TOOL } from './fleet/tools-errors.ts'
import { mountP7, snapshotOf, type DomainTables } from './ui/p7-routes.ts'
import { mountP7 as mountP7Direct } from './ui/p7-routes.ts'


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

/**
 * Graded change events (P4), key `<at>|<subjectKey>|<kind>|<n>`.
 *
 * The key carries the emit instant so the domain's listing preserves order;
 * the fourth segment keeps two events of the same instant/subject/kind unique.
 */
export const eventsDomain = defineDomain({
  name: 'workbench_events',
  version: 1,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: { events: domainTable<string, z.infer<typeof changeEvent>>(changeEvent) },
})

/** Source health snapshots, key `<sourceId>` (fleet health panel of design §5.3). */
export const sourceHealthDomain = defineDomain({
  name: 'workbench_fleet_health',
  version: 1,
  tables: { health: domainTable<string, z.infer<typeof sourceHealth>>(sourceHealth) },
})

/** Every domain the workbench owns, in declaration order. */
export const DOMAINS = [
  eventsDomain,
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

/**
 * P4 row options that are not part of the frozen config schema.
 *
 * They are lifecycle switches (mount the change engine or not), so they stay
 * out of `config.schema.json`; dsh's schemastery row rejects unknown keys.
 */
export interface RowOptions extends Config {
  /** Mount the change engine and the notifier (default false: no tables read). */
  readonly withNotify?: boolean
  /** Feed pairs from a producer hook (`pr-watch`/`issue-watch` `onPair`). */
  readonly feedPair?: (pair: { readonly key: string; readonly before: unknown; readonly after: unknown; readonly at: string }, scope: 'pr' | 'issue') => void
  /** Install the digest task on mount (default true when the digest is enabled). */
  readonly digestTask?: boolean
  /** Override for the login used by "somebody else replied" (defaults to the identity). */
  readonly me?: string
  /** P5: mount the fleet watch and poll the configured sources (default false). */
  readonly withFleet?: boolean
  /** P6: mount the error pipeline and the two error tools (default true once `withFleet` is on). */
  readonly withErrors?: boolean
  /** P6: inject the analysis port (tests/smoke); absent means the host `ctx.llm` (or no model at all). */
  readonly analysisPort?: AnalysisPort
  /** P6: run the `cron_run_events` → error-entry bridge after every watch round (default true when mounted). */
  readonly runEventBridge?: boolean
  /** P6: handed to the P5 watch so every round's error entries reach the pipeline (set by `mountP6`). */
  onRound?: (round: readonly { readonly sourceId: string; readonly state: string; readonly jobs: number; readonly runs: number; readonly errors: number; readonly backoffMs: number; readonly skipped: boolean; readonly message: string | null }[]) => Promise<void>
  /** P5: injectable adapters (tests and the smoke replace the SSH executor). */
  readonly fleetOverrides?: FleetOverrides
}

/** P5 seams a test or smoke can hand the row: process spawner, local files and the service probe. */
export interface FleetOverrides {
  readonly spawn?: (command: string, args: readonly string[], timeoutMs: number, signal?: AbortSignal) => Promise<{ code: number; stdout: string; stderr: string }>
  readonly localFiles?: LocalFiles
  readonly serviceProbe?: LocalServiceProbe
  /** Build adapters directly (the smoke assembles the three real ones). */
  readonly makeSources?: (config: WorkbenchConfig) => readonly FleetSource[]
}

/** The provider the snapshot route reads (set once the six domains are open). */
let uiSnapshotProvider: (() => import('./ui/p7-routes.ts').UiSnapshot) | undefined

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
  /** Row options outside the frozen config (see {@link RowOptions}). */
  readonly options: RowOptions
  /** P4 change engine; null until the row mounted it (`withNotify`). */
  changeEngine: ChangeEngine | null = null
  /** P4 notifier; null until the row mounted it. */
  notifyService: NotifyService | null = null
  /** P4 digest task controller; null until mount. */
  digestController: DigestController | null = null
  /** P5 fleet watch; null until the row mounted it (`withFleet`). */
  fleetWatch: FleetWatchService | null = null
  /** P5 adapters in configured order (empty while the fleet is not mounted). */
  fleetSources: readonly FleetSource[] = []
  /** P6 error pipeline (ledger, analyser, verification); null until `mountP6`. */
  errorPipeline: ErrorPipeline | null = null
  /** Open in progress; retries join it instead of opening the same domains again. */
  private opening: Promise<void> | undefined

  constructor(ctx: Context, raw: Config) {
    super(ctx, 'workbench')
    this.options = raw
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
    // Single-flight: a slow open overlapping a retry would open the same domain
    // twice (the facility then answers `already-open` for the second call and
    // the later handle would replace the first). Retries piggyback on the call
    // already in progress.
    this.opening ??= this.openDomainsOnce().finally(() => {
      this.opening = undefined
    })
    await this.opening
  }

  /** Open every declared domain that this row does not hold yet. */
  private async openDomainsOnce(): Promise<void> {
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
  // P4: the change engine, the notifier and the digest task ride on this row.
  ctx.effect(() => mountP4(ctx, raw as RowOptions), 'workbench:p4')
  // P5: the fleet watch rides on the same row (opt-in through `withFleet`).
  ctx.effect(() => mountP5(ctx, raw as RowOptions), 'workbench:p5')
  // P6: the error pipeline rides on the same row (needs P5's watch and P4's event domain).
  ctx.effect(() => mountP6(ctx, raw as RowOptions), 'workbench:p6')
  // P7: the read-only snapshot route (owner ruling A). The provider waits for
  // the row to open the six domains, then answers from the opened tables; a
  // profile without `webServer` simply gets no route (named in the log).
  ctx.effect(() => {
    let stopped = false
    // The row publishes its service asynchronously; wait for the provider the
    // route reads, then mount the route (a mount without a provider would
    // answer an empty snapshot forever).
    const ready = new Promise<DomainTables>((resolve) => {
      // `snapshotTablesOf` reads `service.domains`; the service only exists after
      // the row publishes it, so it must be probed before it is handed over.
      const poll = () => {
        if (stopped) return
        const service = (workbenchService ?? getWorkbenchService()) as WorkbenchService | undefined
        const tables = service === undefined ? undefined : snapshotTablesOf(service)
        if (tables !== undefined) {
          // The route reads the provider through a module-level holder, so the
          // mount works on any context (ctx.set needs a declared service key).
          uiSnapshotProvider = () => snapshotOf(tables)
          resolve(tables)
          return
        }
        setTimeout(poll, 500)
      }
      poll()
    })
    ready.then(() => {
      if (stopped) return
      // Hand the provider over explicitly: a plain row context has no
      // `workbenchUiSnapshot` service key for `ctx.set`.
      mountP7Direct(ctx, uiSnapshotProvider)
    }).catch((error: unknown) => {
      ctx.logger?.('workbench')?.info?.('workbench p7: the snapshot route did not mount (%s)', String(error))
    })
    return () => {
      stopped = true
    }
  }, 'workbench:p7')
}

/** Wait (bounded) for the six P7 domains, then hand the tables over. */
async function waitForSnapshotTables(service: WorkbenchService, waitedMs = 0): Promise<DomainTables | undefined> {
  const tables = snapshotTablesOf(service)
  if (tables !== undefined) return tables
  if (waitedMs >= 10_000) return undefined
  await new Promise((resolve) => setTimeout(resolve, 500))
  return waitForSnapshotTables(service, waitedMs + 500)
}

/** Read the six snapshot tables out of the opened domains (named spellings of §DOMAIN_NAMES). */
function snapshotTablesOf(service: WorkbenchService): DomainTables | undefined {
  const domains = service.domains as Record<string, unknown>
  const pr = domains.workbench_snapshot_pr as { table(name: string): DomainTables['pr'] } | undefined
  const issue = domains.workbench_snapshot_issue as { table(name: string): DomainTables['issue'] } | undefined
  const jobs = domains.workbench_fleet_jobs as { table(name: string): DomainTables['jobs'] } | undefined
  const errors = domains.workbench_fleet_errors as { table(name: string): DomainTables['errors'] } | undefined
  const events = domains.workbench_events as { table(name: string): DomainTables['events'] } | undefined
  const health = domains.workbench_fleet_health as { table(name: string): DomainTables['health'] } | undefined
  if (pr === undefined || issue === undefined || jobs === undefined || errors === undefined || events === undefined || health === undefined) return undefined
  return {
    pr: pr.table('snapshots'),
    issue: issue.table('snapshots'),
    jobs: jobs.table('jobs'),
    errors: errors.table('records'),
    events: events.table('events'),
    health: health.table('health'),
  }
}

/**
 * P4 mount: notifier, change engine, card kind, status tool and digest task.
 *
 * Everything here is optional and named when absent: a profile without
 * `actionCards`/`schedule`/`tools` keeps the same behaviour as before P4
 * (events are still stored), and the row leaves no disposer behind.
 * @param ctx - row context.
 * @param options - row options (`withNotify` gates the whole mount).
 * @returns the uninstaller for the effect.
 */
function mountP4(ctx: Context, options: RowOptions): () => void {
  const disposers: Array<() => void> = []
  const service = workbenchService
  if (options.withNotify !== true || service === undefined) {
    return () => {
      for (const dispose of disposers) dispose()
    }
    // Nothing below runs without the row options: no table read, no token read.
  }
  const log = (line: string) => {
    ctx.logger?.('workbench')?.info?.(line)
    console.log(line)
  }
  const notifier = new NotifyService({
    actionCards: service.config.notify.actionCards,
    backlogMergeCount: service.config.notify.backlogMergeCount,
    // A card needs an online root agent; the row cannot know before first use.
    agentLive: () => rootAgentsLive(ctx),
    log,
  })
  service.notifyService = notifier
  const engineOf = (tables: P4Tables) =>
    new ChangeEngine({
      events: tables.events,
      prTable: tables.pr,
      issueTable: tables.issue,
      cursors: tables.cursors,
      drainQueue: () => Promise.resolve([]),
      debounceMs: service.config.notify.debounceMs,
      me: options.me,
      log,
      onEvent: (event) => {
        notifier.route(event)
      },
    })
  // The engine needs the opened domains; the row opens them asynchronously.
  let engine: ChangeEngine | undefined
  disposers.push(() => {
    service.changeEngine = null
    service.notifyService = null
    service.digestController = null
  })
  void Promise.resolve().then(async () => {
    const tables = await waitForTables(service)
    if (tables === undefined) {
      log('p4 skipped: storage domains did not open; the change engine stays unmounted')
      return
    }
    engine = engineOf(tables)
    service.changeEngine = engine
    // A producer hook (P2/P3 `onPair`) hands pairs straight to the engine.
    if (options.feedPair !== undefined) {
      const feed = options.feedPair
      ;(globalThis as { __workbenchFeed?: typeof feed }).__workbenchFeed = (pair, scope) => {
        if (service.changeEngine === null) return
        void service.changeEngine.consumePair(pair, scope)
      }
    }
    const cards = ctx.get?.('actionCards') as { register(kind: unknown): () => void } | undefined
    if (cards === undefined) {
      notifier.markRegistered(false)
    } else {
      disposers.push(cards.register(notifyKind()))
      notifier.markRegistered(true)
    }
    const tools = ctx.get?.('tools') as { register(definition: unknown): () => void } | undefined
    if (tools === undefined) {
      log('p4 skipped: the tools service is not mounted; workbench_status is not registered')
    } else {
      disposers.push(
        tools.register({
          name: STATUS_TOOL,
          description: STATUS_DESCRIPTION,
          parameters: {
            scope: { type: 'string', enum: STATUS_SCOPES, default: 'all', description: 'Which half of the workbench to summarize.' },
            since: { type: 'string', description: 'ISO 8601 floor; defaults to 24 hours before the call.' },
          },
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: { text: { type: 'string', required: true } },
            },
            render: (_args: unknown, value: { text: string }) => [{ type: 'text', text: value.text }],
          },
          execute: async (args: { scope?: 'all' | 'community' | 'fleet'; since?: string }) =>
            ({ text: statusText(service, args.scope ?? 'all', args.since) }),
        }),
      )
    }
    const schedule = ctx.get?.('schedule') as SchedulePort | undefined
    const digest = new DigestController({
      enabled: service.config.notify.digest.enabled,
      cron: service.config.notify.digest.cron,
      timeZone: service.config.notify.digest.timeZone,
      taskTitle: service.config.notify.digest.taskTitle,
      schedule,
      log,
    })
    service.digestController = digest
    const action = await digest.ensure().catch((error: unknown) => {
      log(`digest ensure failed: ${error instanceof Error ? error.message : String(error)}`)
      return 'skipped' as const
    })
    log(`digest task action=${action} title="${service.config.notify.digest.taskTitle}"`)
  })
  disposers.push(() => {
    void service.digestController?.clear().catch(() => undefined)
  })
  return () => {
    for (const dispose of disposers.splice(0).reverse()) dispose()
  }
}

/** The tables the engine needs (all four are opened by the row itself). */
interface P4Tables {
  readonly events: EventsTable
  readonly pr: PrSnapshotTable
  readonly issue: IssueSnapshotTable
  readonly cursors: CursorTable
}

/** Read the opened domains back as the engine's table surface. */
function p4Tables(service: WorkbenchService): P4Tables | undefined {
  const domains = service.domains as Record<string, unknown>
  const events = domains.workbench_events as { table(name: string): EventsTable } | undefined
  const pr = domains.workbench_snapshot_pr as { table(name: string): PrSnapshotTable } | undefined
  const issue = domains.workbench_snapshot_issue as { table(name: string): IssueSnapshotTable } | undefined
  const cursors = domains.workbench_cursors as { table(name: string): CursorTable } | undefined
  if (events === undefined || pr === undefined || issue === undefined || cursors === undefined) return undefined
  return { events: events.table('events'), pr: pr.table('snapshots'), issue: issue.table('snapshots'), cursors: cursors.table('cursors') }
}

/** Wait (bounded) for the row to open its domains, then hand them back. */
async function waitForTables(service: WorkbenchService, waitedMs = 0): Promise<P4Tables | undefined> {
  const tables = p4Tables(service)
  if (tables !== undefined) return tables
  if (waitedMs >= 10_000) return undefined
  await new Promise((resolve) => setTimeout(resolve, 500))
  return waitForTables(service, waitedMs + 500)
}

/** Whether at least one root agent is live (the action-card host condition). */
function rootAgentsLive(ctx: Context): boolean {
  const agents = ctx.get?.('agents') as { roots?: () => readonly unknown[] } | undefined
  try {
    return (agents?.roots?.() ?? []).length > 0
  } catch {
    return false
  }
}

/** Status text for the tool and the smoke (same builder, same numbers). */
function statusText(service: WorkbenchService, scope: 'all' | 'community' | 'fleet', since?: string): string {
  const tables = p4Tables(service)
  const events = tables?.events as unknown as { keys(): readonly string[]; get(key: string): ChangeEvent | undefined } | undefined
  const prSnapshots = (service.domains as Record<string, unknown>).workbench_snapshot_pr as
    | { table(name: string): { keys(): readonly string[] } }
    | undefined
  const issueSnapshots = (service.domains as Record<string, unknown>).workbench_snapshot_issue as
    | { table(name: string): { keys(): readonly string[] } }
    | undefined
  const report = buildStatus(
    {
      events: events ?? { keys: () => [], get: () => undefined },
      prCount: () => prSnapshots?.table('snapshots').keys().length ?? 0,
      issueCount: () => issueSnapshots?.table('snapshots').keys().length ?? 0,
      fleet: fleetCounts(service),
    },
    scope,
    since,
  )
  return report.text
}


/**
 * P5 mount: build the adapters from the configured sources and start the watch.
 *
 * Everything is opt-in (`withFleet`) and named when absent, and the sources
 * themselves decide how to reach their hosts (injectable through
 * {@link FleetOverrides} so the smoke can replay without touching a real machine).
 * @param ctx - row context.
 * @param options - row options.
 * @returns the uninstaller for the effect.
 */
function mountP5(ctx: Context, options: RowOptions): () => void {
  const service = workbenchService
  if (options.withFleet !== true || service === undefined) return () => undefined
  const log = (line: string) => {
    ctx.logger?.('workbench')?.info?.(line)
    console.log(line)
  }
  let watch: FleetWatchService | null = null
  let stopped = false
  void Promise.resolve().then(async () => {
    const tables = await waitForFleetTables(service)
    if (tables === undefined) {
      log('p5 skipped: fleet storage domains did not open; the fleet watch stays unmounted')
      return
    }
    if (stopped) return
    const sources = options.fleetOverrides?.makeSources?.(service.config) ?? buildSources(service.config, options.fleetOverrides, log)
    service.fleetSources = sources
    try {
      watch = new FleetWatchService({
        sources,
        tables,
        intervalMs: service.config.poll.fleetIntervalMs,
        backoffMaxMs: service.config.poll.backoffMaxMs,
        log,
        autoStart: false,
        ...(options.onRound === undefined ? {} : { onRound: options.onRound }),
      })
      service.fleetWatch = watch
      log(`p5 ready: ${String(sources.length)} fleet source(s), interval ${String(service.config.poll.fleetIntervalMs)}ms`)
    } catch (error: unknown) {
      log(`p5 skipped: fleet watch failed to start (${error instanceof Error ? error.message : String(error)})`)
    }
  })
  return () => {
    stopped = true
    watch?.stop()
    service.fleetWatch = null
    service.fleetSources = []
  }
}

/**
 * P6 mount: the error pipeline, the `script_error` bridge, and the two error tools.
 *
 * Ordering rules that the code cannot infer:
 * - the watch is created by `mountP5`, which runs first; when it is not in seat
 *   the pipeline still mounts (fixtures can drive it) and the bridge stays off;
 * - the bridge needs a *whitelisted* remote reader, so it only turns on for a
 *   `hermes-ssh` source whose `ssh.dbPath` is configured (plan §2.5);
 * - writes only exist through the approval seam: `workbench_resolve` is
 *   registered with a `tools/pre-execute` guard that asks `ctx.approval`
 *   (`allowed-once` is the only grant). A profile without the seam gets no tool.
 * @param ctx - row context.
 * @param options - row options.
 * @returns the uninstaller for the effect.
 */
function mountP6(ctx: Context, options: RowOptions): () => void {
  const service = workbenchService
  if (service === undefined || options.withFleet !== true || options.withErrors === false) return () => undefined
  const log = (line: string) => {
    ctx.logger?.('workbench')?.info?.(line)
    console.log(line)
  }
  const disposers: Array<(() => void)> = []
  let stopped = false
  void Promise.resolve().then(async () => {
    const tables = await waitForPipelineTables(service)
    if (tables === undefined) {
      log('p6 skipped: error/fingerprint/event domains did not open; the error pipeline stays unmounted')
      return
    }
    if (stopped) return
    const port = options.analysisPort ?? hostAnalysisPort(ctx, service.config)
    const analyzer = service.config.analysis.llm.enabled && port !== undefined ? new ErrorAnalyzer({ port }) : undefined
    if (!service.config.analysis.llm.enabled) log('p6: analysis.llm.enabled=false; every record stays pending (named)')
    else if (analyzer === undefined) log('p6: no LLM service is mounted in this profile; every record stays pending (named)')
    const pipeline = new ErrorPipeline({
      tables,
      analyzer,
      greenRunsToVerify: service.config.analysis.greenRunsToVerify,
      retentionDays: service.config.analysis.retentionDays,
      recentRuns: (sourceId, jobId) => recentRunsOf(service, sourceId, jobId),
      log,
    })
    service.errorPipeline = pipeline
    const resolver = new ErrorResolver({ pipeline })
    // The watch (P5) hands each round's error entries to the pipeline.
    const watch = service.fleetWatch
    const watcher = service as { onRound?: (round: readonly { sourceId: string; errors: number }[]) => Promise<void> }
    if (options.runEventBridge !== false && watcher.onRound === undefined) {
      watcher.onRound = async () => {
        await pipeline.verify()
      }
    }
    const watchPresent = watch !== null
    if (!watchPresent) log('p6: the fleet watch is not in seat; the pipeline waits for fixture replay')
    const bridge = options.runEventBridge === false ? undefined : makeRunEventBridge(service, pipeline, log)
    if (bridge !== undefined) {
      disposers.push(bridge.stop)
      bridge.start()
    }
    registerErrorTools(ctx, pipeline, resolver, log, disposers)
    log(`p6 ready: greenRunsToVerify=${String(service.config.analysis.greenRunsToVerify)} retentionDays=${String(service.config.analysis.retentionDays)} bridge=${bridge === undefined ? 'off' : 'on'}`)
  })
  return () => {
    stopped = true
    for (const dispose of disposers.splice(0).reverse()) dispose()
    service.errorPipeline = null
  }
}

/** Wait (bounded) for the three P6 tables to be open. */
async function waitForPipelineTables(service: WorkbenchService, waitedMs = 0): Promise<PipelineTables | undefined> {
  const tables = pipelineTablesOf(service)
  if (tables !== undefined) return tables
  if (waitedMs >= 10_000) return undefined
  await new Promise((resolve) => setTimeout(resolve, 500))
  return waitForPipelineTables(service, waitedMs + 500)
}

/** Read the error/fingerprint/job/event tables out of the opened domains. */
function pipelineTablesOf(service: WorkbenchService): PipelineTables | undefined {
  const domains = service.domains as Record<string, unknown>
  const errors = domains.workbench_fleet_errors as { table(name: string): PipelineTables['errors'] } | undefined
  const fingerprints = domains.workbench_fingerprints as { table(name: string): PipelineTables['fingerprints'] } | undefined
  const jobs = domains.workbench_fleet_jobs as { table(name: string): PipelineTables['jobs'] } | undefined
  const events = domains.workbench_events as { table(name: string): PipelineTables['events'] } | undefined
  if (errors === undefined || fingerprints === undefined || jobs === undefined || events === undefined) return undefined
  return { errors: errors.table('records'), fingerprints: fingerprints.table('fingerprints'), jobs: jobs.table('jobs'), events: events.table('events') }
}

/** The last runs of one job, newest first (empty when the watch has not seen it yet). */
function recentRunsOf(service: WorkbenchService, sourceId: string, jobId: string): readonly { startedAt: string; status: string }[] {
  const record = pipelineTablesOf(service)?.jobs.get(`${sourceId}/${jobId}`)
  return record === undefined || record.lastRunAt === null ? [] : [{ startedAt: record.lastRunAt, status: record.lastStatus ?? 'unknown' }]
}

/**
 * Adapter from dsh-llm to the analyser port: the host's default provider/model
 * (`ctx.llm.listProviders()` order, `agent-default-model` when mounted), or
 * undefined when the profile carries no LLM service.
 */
function hostAnalysisPort(ctx: Context, _config: WorkbenchConfig): AnalysisPort | undefined {
  const llm = ctx.get?.('llm') as
    | {
        stream(options: { provider: string; model: string; messages: readonly { role: 'user'; content: string }[]; system?: string; maxTokens?: number }): AsyncIterable<AnalysisChunk>
        listProviders?(): readonly { id?: string; models?: readonly { id: string }[] }[]
      }
    | undefined
  if (llm === undefined) return undefined
  const providers = llm.listProviders?.() ?? []
  const first = providers[0]
  const firstModel = first?.models?.[0]
  if (first?.id === undefined || firstModel?.id === undefined) return undefined
  return {
    provider: first.id,
    model: firstModel.id,
    stream: (request: AnalysisRequest) =>
      llm.stream({ provider: request.provider, model: request.model, messages: request.messages, system: request.system, maxTokens: request.maxTokens }),
  }
}

/** The bridge: `cron_run_events` → error entries, on the P5 ssh whitelist. */
function makeRunEventBridge(service: WorkbenchService, pipeline: ErrorPipeline, log: (line: string) => void): { start: () => void; stop: () => void } | undefined {
  const source = service.config.fleet.find((entry) => entry.kind === 'hermes-ssh' && entry.enabled !== false && entry.ssh?.dbPath !== undefined)
  if (source === undefined || source.ssh?.dbPath === undefined) {
    log('p6: no hermes-ssh source with ssh.dbPath is configured; the cron_run_events bridge stays off (named)')
    return undefined
  }
  const dbPath = source.ssh.dbPath
  const target = { host: source.ssh.host, sshOptions: source.ssh.sshOptions }
  const run = makeRunRemote(target, { spawn: spawnProcess })
  let timer: ReturnType<typeof setInterval> | undefined
  let stopped = false
  let token: string | null = null
  const tick = async () => {
    if (stopped) return
    const pulled = await pullRunEventErrors({ sourceId: source.id, dbPath, query: (sql) => run({ kind: 'sqlite-json', dbPath, sql }).then((answer) => ({ code: answer.code, stdout: answer.stdout, stderr: answer.stderr })) }, token === null ? null : { token })
    token = pulled.cursor.token
    if (pulled.entries.length > 0) {
      const outcome = await pipeline.ingest(pulled.entries)
      log(`p6 bridge source=${source.id} opened=${String(outcome.opened)} revisited=${String(outcome.revisited)} reopened=${String(outcome.reopened)}`)
    }
  }
  return {
    start: () => {
      void tick().catch((error: unknown) => log(`p6 bridge round failed: ${error instanceof Error ? error.message : String(error)}`))
      timer = setInterval(() => {
        void tick().catch((error: unknown) => log(`p6 bridge round failed: ${error instanceof Error ? error.message : String(error)}`))
      }, service.config.poll.fleetIntervalMs)
    },
    stop: () => {
      stopped = true
      if (timer !== undefined) clearInterval(timer)
    },
  }
}

/**
 * Register `workbench_errors` (read-only) and `workbench_resolve` (write).
 *
 * The write tool is guarded by `tools/pre-execute`: it asks `ctx.approval` and
 * runs only on `allowed-once`. Without an approval seam the tool is not
 * registered at all, so the write path fails closed instead of silently writing.
 */
function registerErrorTools(ctx: Context, pipeline: ErrorPipeline, resolver: ErrorResolver, log: (line: string) => void, disposers: Array<() => void>): void {
  const tools = ctx.get?.('tools') as { register(definition: unknown): () => void; on?(event: 'tools/pre-execute', listener: (exec: { name: string }, next: () => Promise<unknown>) => Promise<unknown>): () => void } | undefined
  if (tools === undefined) {
    log('p6 skipped: the tools service is not mounted; workbench_errors/workbench_resolve are not registered')
    return
  }
  disposers.push(
    tools.register({
      name: ERRORS_TOOL,
      description: ERRORS_DESCRIPTION,
      parameters: {
        source: { type: 'string', description: 'Fleet source id.' },
        state: { type: 'string', description: 'Lifecycle state filter.' },
        severity: { type: 'string', description: 'Severity filter.' },
        limit: { type: 'number', description: 'Maximum records.' },
      },
      output: { schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } }, render: (_args: unknown, value: { text: string }) => [{ type: 'text', text: value.text }] },
      execute: async (args: { source?: string; state?: string; severity?: string; limit?: number }) =>
        ({ text: (await import('./fleet/tools-errors.ts')).renderErrors(pipeline.records(), args as never) }),
    }),
  )
  const approval = ctx.get?.('approval') as { request(request: unknown): Promise<string> } | undefined
  if (tools.on === undefined || approval === undefined) {
    log('p6: no approval seam in this profile; workbench_resolve is not registered (the write path fails closed)')
    return
  }
  disposers.push(
    tools.on('tools/pre-execute', async (exec, next) => {
      if (exec.name !== RESOLVE_TOOL) return next()
      const agent = (exec as { agent?: unknown }).agent
      const outcome = await approval.request({ agent, toolName: RESOLVE_TOOL, reason: 'workbench_resolve writes the error ledger (fix-applied / wontfix / reopen)' })
      if (outcome !== 'allowed-once') return { kind: 'deny', reason: `workbench_resolve requires approval (${String(outcome)})` }
      return next()
    }),
  )
  disposers.push(
    tools.register({
      name: RESOLVE_TOOL,
      description: RESOLVE_DESCRIPTION,
      parameters: {
        recordId: { type: 'string', description: 'Ledger record id.' },
        action: { type: 'string', enum: ['fix-applied', 'wontfix', 'reopen'], description: 'Which resolution step to register.' },
        note: { type: 'string', description: 'What was done.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true }, ok: { type: 'boolean', required: true } } },
        render: (_args: unknown, value: { text: string }) => [{ type: 'text', text: value.text }],
      },
      execute: async (args: { recordId: string; action: 'fix-applied' | 'wontfix' | 'reopen'; note?: string }) => {
        const outcome = await resolver.resolve({ ...args, by: 'tool' })
        return { text: outcome.text, ok: outcome.ok }
      },
    }),
  )
}

/** Build the three adapter kinds from the frozen config (unknown kinds are named and skipped). */
function buildSources(config: WorkbenchConfig, overrides: FleetOverrides | undefined, log: (line: string) => void): readonly FleetSource[] {
  const sources: FleetSource[] = []
  for (const entry of config.fleet) {
    if (entry.enabled === false) {
      log(`p5: fleet source ${entry.id} is disabled in config; not polled`)
      continue
    }
    if (entry.kind === 'hermes-ssh') {
      const ssh = entry.ssh
      if (ssh === undefined) continue
      const run = makeRunRemote({ host: ssh.host, sshOptions: ssh.sshOptions }, { spawn: overrides?.spawn ?? spawnProcess })
      sources.push(new HermesSshAdapter({ config: entry, run, log }))
      continue
    }
    if (entry.kind === 'jiuwenswarm-local') {
      const files = overrides?.localFiles ?? makeLocalFiles()
      const service = overrides?.serviceProbe ?? makeSystemdProbe()
      sources.push(new JiuwenswarmLocalAdapter({ config: entry, files, service, log }))
      continue
    }
    if (entry.kind === 'ssh-sqlite') {
      const ssh = entry.ssh
      if (ssh === undefined) continue
      const run = makeRunRemote({ host: ssh.host, sshOptions: ssh.sshOptions }, { spawn: overrides?.spawn ?? spawnProcess })
      sources.push(new GenericSshSqliteAdapter({ config: entry as unknown as FleetSourceConfigWithQueries, run, log }))
      continue
    }
    log(`p5: fleet source ${entry.id} has unknown kind; skipped`)
  }
  return sources
}

/** The generic config carries the three optional queries added by ADR P5-1. */
type FleetSourceConfigWithQueries = Parameters<typeof GenericSshSqliteAdapter.prototype.listJobs> extends never ? never : (FleetSourceConfigResolved & { query?: string; runsQuery?: string; jobsQuery?: string; errorsQuery?: string })

/** Spawn one process and collect its streams (SIGKILL on abort or timeout). */
function spawnProcess(command: string, args: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
    }, timeoutMs)
    const abort = () => {
      child.kill('SIGKILL')
    }
    signal?.addEventListener('abort', abort)
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error: Error) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      reject(error)
    })
    child.on('close', (code: number | null) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

/** Local files through `node:fs` (read-only; SQL through a `mode=ro` URI). */
function makeLocalFiles(): LocalFiles {
  const readTail = async (path: string, bytes: number): Promise<{ code: number; text: string }> => {
    try {
      const stat = await fsPromises.stat(path)
      const start = Math.max(0, stat.size - bytes)
      const handle = await fsPromises.open(path, 'r')
      try {
        const buffer = Buffer.alloc(stat.size - start)
        await handle.read(buffer, 0, buffer.length, start)
        return { code: 0, text: buffer.toString('utf8') }
      } finally {
        await handle.close()
      }
    } catch (error: unknown) {
      return { code: 2, text: String(error) }
    }
  }
  return {
    tail: readTail,
    stat: async (path: string) => {
      try {
        const stat = await fsPromises.stat(path)
        return { code: 0, text: `${String(stat.dev)} ${String(stat.ino)} ${String(stat.size)}` }
      } catch {
        return { code: 2, text: '' }
      }
    },
    list: async (path: string) => {
      try {
        return { code: 0, names: await fsPromises.readdir(path) }
      } catch {
        return { code: 2, names: [] }
      }
    },
    sqlite: async (dbPath: string, sql: string) => {
      try {
        const { execFile } = await import('node:child_process')
        const uri = `file:${dbPath}?mode=ro`
        return await new Promise<{ code: number; text: string }>((resolve) => {
          execFile('sqlite3', ['-json', uri, sql], { timeout: 30_000 }, (error, stdout) => {
            resolve({ code: error === null ? 0 : 2, text: stdout })
          })
        })
      } catch {
        return { code: 2, text: '' }
      }
    },
  }
}

/** The systemd user unit probe; the bus env is filled in when the caller's shell lacks it. */
function makeSystemdProbe(): LocalServiceProbe {
  return {
    isActive: async () => {
      const env = { ...process.env } as Record<string, string>
      env['XDG_RUNTIME_DIR'] ??= `/run/user/${String(typeof process.getuid === 'function' ? process.getuid() : 1000)}`
      env['DBUS_SESSION_BUS_ADDRESS'] ??= `unix:path=${env['XDG_RUNTIME_DIR']}/systemd/private`
      const result = await new Promise<{ code: number; out: string }>((resolve) => {
        execFile('systemctl', ['--user', 'is-active', 'jiuwenswarm.service'], { env, timeout: 10_000 }, (error, stdout) => {
          resolve({ code: error === null ? 0 : 2, out: stdout.trim() })
        })
      })
      return { active: result.code === 0 && result.out === 'active', message: result.code === 0 ? null : `systemctl --user is-active returned ${result.out || 'an error'}` }
    },
  }
}

/** Wait (bounded) for the fleet tables to be open. */
async function waitForFleetTables(service: WorkbenchService, waitedMs = 0): Promise<FleetWatchTables | undefined> {
  const tables = fleetTables(service)
  if (tables !== undefined) return tables
  if (waitedMs >= 10_000) return undefined
  await new Promise((resolve) => setTimeout(resolve, 500))
  return waitForFleetTables(service, waitedMs + 500)
}

/** Read the three fleet domain tables plus the event log. */
function fleetTables(service: WorkbenchService): FleetWatchTables | undefined {
  const domains = service.domains as Record<string, unknown>
  const jobs = domains.workbench_fleet_jobs as { table(name: string): FleetWatchTables['jobs'] } | undefined
  const cursors = domains.workbench_cursors as { table(name: string): FleetWatchTables['cursors'] } | undefined
  const health = domains.workbench_fleet_health as { table(name: string): FleetWatchTables['health'] } | undefined
  const events = domains.workbench_events as { table(name: string): FleetWatchTables['events'] } | undefined
  if (jobs === undefined || cursors === undefined || health === undefined || events === undefined) return undefined
  return { jobs: jobs.table('jobs'), cursors: cursors.table('cursors'), health: health.table('health'), events: events.table('events') }
}

/** Fleet counters for the status tool (null while the fleet is not mounted). */
function fleetCounts(service: WorkbenchService): { jobs: number; errors: number; sourcesUp: number; sourcesTotal: number } | null {
  const domains = service.domains as Record<string, unknown>
  const fleetJobs = domains.workbench_fleet_jobs as { table(name: string): { keys(): readonly string[] } } | undefined
  const fleetErrors = domains.workbench_fleet_errors as { table(name: string): { keys(): readonly string[] } } | undefined
  const fleetHealth = domains.workbench_fleet_health as { table(name: string): { keys(): readonly string[]; get(key: string): { state?: string } | undefined } } | undefined
  if (fleetJobs === undefined && fleetErrors === undefined && fleetHealth === undefined) return null
  const healthKeys = fleetHealth?.table('health').keys() ?? []
  const up = healthKeys.filter((key) => fleetHealth?.table('health').get(key)?.state === 'up').length
  return { jobs: fleetJobs?.table('jobs').keys().length ?? 0, errors: fleetErrors?.table('records').keys().length ?? 0, sourcesUp: up, sourcesTotal: healthKeys.length }
}

/**
 * Community surface (P2): the seeding/watch building blocks and the
 * redact/identity helpers the smoke script composes with.
 */
export {
  resolveIdentities,
  effectiveLogin,
  redact,
  redact as redactLine,
  tokenOf,
  type PlatformIdentity,
  type IdentityOptions,
} from './community/identity.ts'
export {
  seedPullRequests,
  parseRepo,
  lastPageOf,
  dedupe,
  seededKey,
  seedCursorToken,
  type SeededPr,
  type SeedOutcome,
  type SeedHealth,
} from './community/seeding.ts'
export { GithubProvider, fetchGithub, snapshotOf, rollupOf, mergeabilityOf, reviewDecisionOf, githubKey } from './community/github.ts'
export { forgeWatchSource, makeGitCodeWatchSource } from './community/gitcode-watch.ts'
export {
  PrWatchService,
  makePrWatchService,
  createMemoryTables,
  capabilityNotes,
  writeCapabilities,
  watchKey,
  QUEUE_CAPACITY,
  type WatchRef,
  type WatchSource,
  type WatchUpdate,
  type PrWatchOptions,
} from './community/pr-watch.ts'
/**
 * Community surface (P3): the issue poller, both readers and the row binder.
 */
export {
  IssueWatchService,
  makeIssueWatchService,
  createIssueMemoryTables,
  issueKey,
  issueDiffers,
  isForeignReply,
  parseIssueRepos,
  emptyIssueQueue,
  ISSUE_DIFF_FIELDS,
  type IssueWatchOptions,
  type IssueTable,
  type IssueQueueRecord,
  type PlatformCursorRecord,
} from './community/issue-watch.ts'
export {
  GithubIssueReader,
  lastPageOfLink,
  repoFromApiUrl,
  GITHUB_LIST_PER_PAGE,
  type GithubIssueJson,
  type GithubSearchItem,
} from './community/issue-watch-github.ts'
export {
  GitcodeIssueReader,
  issueNumberOf,
  labelNamesOf,
  GITCODE_ISSUE_PER_PAGE,
  type GitcodeIssueJson,
} from './community/issue-watch-gitcode.ts'
export {
  makeIssueSources,
  GITHUB_LIST_REFRESH_MS,
  type IssueSourceOptions,
  type IssueSourcesResult,
} from './community/issue-sources.ts'
export {
  IssuePollRunner,
  startIssueWatch,
  type IssueWatchHandle,
  type RoundOutcome,
  type StartIssueWatchOptions,
} from './community/community-row.ts'
/**
 * Core surface (P4): the grading table, the change engine, the notifier, the
 * digest task and the read-only status tool (the smoke drives them directly).
 */
export { ChangeEngine, RING_SIZE, EVIDENCE_CAP, type ChangeEngineOptions, type CursorTable, type EventsTable, type IssueSnapshotTable, type PrSnapshotTable, type PairScope } from './core/change-engine.ts'
export { CHANGE_LEVELS, classifyChange, type ChangeEvent, type ChangeKind, type ChangeLevel, type SnapshotPair } from '../../../contracts/events.ts'
export { COMMUNITY_RULES, FIRST_OBSERVATION_KINDS, FLEET_KINDS, EVIDENCE_CAP_TRUNCATION_MARKER, gradePair, gradeIssuePair, isFirstObservation, type GradedChange } from './core/grade.ts'
export { NotifyService, makeEventLog, type CardProposal, type NotifyState, type NotifyOptions, type Route } from './core/notify.ts'
export { DigestController, DIGEST_WINDOW_HOURS, digestPrompt, type DigestAction, type SchedulePort, type ScheduleTaskLike } from './core/digest.ts'
export { buildStatus, STATUS_TOOL, STATUS_DESCRIPTION, STATUS_SCOPES, STATUS_WINDOW_HOURS, type StatusReport } from './core/tools-status.ts'
export { NOTIFY_ACTION, NOTIFY_SKILL, notifyDetails, notifyKind, skillText } from './core/notify-skill.ts'
export type { ScheduleTiming } from './core/schedule-types.ts'
/**
 * Error surface (P6): masking, fingerprint, state machine, analyser, pipeline,
 * resolver, the two tools and the event-key codec.
 */
export { maskSecrets, sampleOf, SAMPLE_MAX_BYTES, TRUNCATION_MARKER } from './fleet/secret-mask.ts'
export { normalize, signatureOf, evaluateSamples, SIGNATURE_PREFIX, type FingerprintSet, type FingerprintCase, type FingerprintVerdict } from './fleet/fingerprint.ts'
export { ISSUE_STATES, LEGAL_TRANSITIONS, IllegalTransitionError, canTransition, assertTransition, stepOf, applyStep, maybeVerify, recordWithAnalysis, type AnalysisPayload } from './fleet/issues-machine.ts'
export { ErrorAnalyzer, AnalysisFormatError, buildPrompt, parseAnalysis, detailHashOf, detailTextOf, similarity, levenshtein, ANALYSIS_OUTPUT_SCHEMA_TEXT, DEFAULT_CACHE_SIMILARITY, type AnalysisPort, type AnalysisChunk, type AnalysisRequest, type AnalysisOutput, type AnalysisCallResult } from './fleet/analyzer.ts'
export { ErrorPipeline, pullRunEventErrors, SAMPLE_RING, RUN_EVENTS_SQL, type PipelineTables, type ErrorPipelineOptions, type IngestOutcome, type PumpOutcome } from './fleet/error-pipeline.ts'
export { eventKeyOf as errorEventKeyOf, decodeEventKey, ESCAPE_TABLES, type EventKeyParts } from './fleet/event-key.ts'
export { ErrorResolver, RESOLVE_ACTIONS, stateBadge, type ResolveAction, type ResolveOutcome } from './fleet/resolver.ts'
export { ERRORS_TOOL, RESOLVE_TOOL, ERRORS_DESCRIPTION, RESOLVE_DESCRIPTION, errorsTool, resolveTool, renderErrors, DEFAULT_LIMIT, type ErrorsQuery } from './fleet/tools-errors.ts'
export {
  fetchHttpGet,
  parseJson,
  retryAfterMs,
  rateLimitRemaining,
  rateLimitResetMs,
  type HttpGet,
  type HttpGetResponse,
} from './community/http-get.ts'
export type {
  IssueDetail,
  IssueFailure,
  IssueListAnswer,
  IssuePlatformSource,
  IssueRef,
  LastComment,
  ListedIssue,
  PollResult,
} from './community/issue-types.ts'

/**
 * Fleet surface (P5): the SSH executor with the read-only whitelist, the tail
 * cursor, the three adapters, the grading table and the watch.
 */
export { assertReadOnly, buildRemoteCommand, makeRunRemote, sshArgs, stripTunnelNoise, type RemoteReadonly, type RemoteResult, type RunRemote, type SshTarget, type RunRemoteDeps } from './fleet/ssh-exec.ts'
export { advance, parseLogLines, type FileMark, type ParsedLogLine, type TailResult } from './fleet/log-tail.ts'
export { HermesSshAdapter, HERMES_DEFAULTS, HERMES_LOG_WINDOW_BYTES, jobOf, markOf, parseJobsJson, parseJsonRows, runsFromRows, runsSql, type HermesOptions, type HermesRunRow } from './fleet/hermes-ssh.ts'
export { JiuwenswarmLocalAdapter, JIUWENSWARM_PATHS, jobOf as jiuwenswarmJobOf, ledgerSql, parseJobs, parseSqliteJson, runOf, statusOfRow, type JiuwenswarmOptions, type JiuwenswarmRunRow, type LocalFiles, type LocalServiceProbe } from './fleet/jiuwenswarm-local.ts'
export { GenericSshSqliteAdapter, boundarySql, errorOfRow, jobOfRow, parseRows, runOfRow, type GenericOptions, type GenericNotes, type GenericSourceConfig } from './fleet/generic-ssh-sqlite.ts'
export { P5_EMITTABLE_KINDS, P6_RESERVED_KINDS, gradeHealth, gradeRun, healthKey, runKey, type FleetGraded } from './fleet/grade-fleet.ts'
export { FleetWatchService, backoffFor, eventKeyOf, type FleetWatchOptions, type FleetWatchTables, type SourceRound } from './fleet/fleet-watch.ts'
