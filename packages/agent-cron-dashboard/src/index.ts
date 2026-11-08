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
import { ChangeEngine, type CursorTable, type EventsTable, type IssueSnapshotTable, type PrSnapshotTable } from './core/change-engine.ts'
import { DigestController, type SchedulePort } from './core/digest.ts'
import { NotifyService } from './core/notify.ts'
import { NOTIFY_ACTION, notifyKind, skillText } from './core/notify-skill.ts'
import { STATUS_DESCRIPTION, STATUS_SCOPES, STATUS_TOOL, buildStatus } from './core/tools-status.ts'

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
}

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
      fleet: null,
    },
    scope,
    since,
  )
  return report.text
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
