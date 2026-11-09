/**
 * Workbench read side (P7): the storage-domain tables projected into one
 * `UiSnapshot`, and the read-only JSON route that hands it to the page.
 *
 * The module owns three exports the plan names: {@link DomainTables} (the
 * table surface a snapshot is computed from), {@link snapshotOf} (a pure
 * projection, so the mapping is unit-testable without a host), and
 * {@link mountP7} (registers `GET|HEAD /workbench/ui-snapshot.json` and
 * returns a synchronous disposer).
 *
 * Rules the projection keeps:
 * - the ledger is a ≤6 key projection per row: samples/message text never
 *   leave the storage domain, and any text that does is masked once more;
 * - a domain that cannot be read lands in `missing[]` instead of throwing;
 * - `workbench_events` is keyed by the codec P6 writes (P6 encoded) or the
 *   literal `<at>|<subjectKey>|<kind>|<n>` P4/P5 write; both are decoded
 *   through `decodeEventKey`, and the decoded segments must agree with the
 *   event body or the row is dropped.
 */
import type { ChangeEvent } from '../../../../contracts/events.ts'
import type { FleetJobRecord, IssueRecord, IssueSnapshot, PrSnapshot, SourceHealth } from '../../../../contracts/records.ts'
import { maskSecrets } from '../fleet/secret-mask.ts'
import { decodeEventKey } from '../fleet/event-key.ts'

/** Route path the page (P7b) and the probe fetch the snapshot from. */
export const SNAPSHOT_PATH = '/workbench/ui-snapshot.json'
/** How many events the snapshot carries (newest first). */
export const EVENT_LIMIT = 200
/** Upper bound of the serialized snapshot; a bigger body sets `truncated`. */
export const SNAPSHOT_MAX_BYTES = 1_048_576

/** One table as the storage domain hands it over. */
interface Table<T> {
  get(key: string): T | undefined
  keys(): readonly string[]
}

/** The six tables a snapshot reads (`workbench_snapshot_pr/pr` is named `snapshots` in its domain). */
export interface DomainTables {
  readonly pr: Table<PrSnapshot>
  readonly issue: Table<IssueSnapshot>
  readonly jobs: Table<FleetJobRecord>
  readonly errors: Table<IssueRecord>
  readonly events: Table<ChangeEvent>
  readonly health: Table<SourceHealth>
}

/** The domain name → table name spelling every P4/P5/P6 mount already uses. */
export const DOMAIN_NAMES = {
  pr: { domain: 'workbench_snapshot_pr', table: 'snapshots' },
  issue: { domain: 'workbench_snapshot_issue', table: 'snapshots' },
  jobs: { domain: 'workbench_fleet_jobs', table: 'jobs' },
  errors: { domain: 'workbench_fleet_errors', table: 'records' },
  events: { domain: 'workbench_events', table: 'events' },
  health: { domain: 'workbench_fleet_health', table: 'health' },
} as const

/** One pull/merge request row (contract fields only). */
export interface PrRow {
  readonly key: string
  readonly platform: string
  readonly repo: string
  readonly number: number
  readonly title: string
  readonly state: string
  readonly draft: boolean
  readonly mergeability: string
  readonly reviewDecision: string
  readonly checksRollup: string
  readonly lastSeenAt: string
}

/** One issue row (contract fields only). */
export interface IssueRow {
  readonly key: string
  readonly platform: string
  readonly repo: string
  readonly number: number
  readonly title: string
  readonly state: string
  readonly labels: readonly string[]
  readonly assignees: readonly string[]
  readonly comments: number
  readonly lastCommentBy: string | null
  readonly lastCommentAt: string | null
  readonly updatedAt: string
}

/** One ledger row: **six** top-level keys, no sample text. */
export interface LedgerRow {
  readonly recordId: string
  readonly state: string
  readonly severity: string
  readonly count: number
  readonly lastSeen: string
  readonly analysisState: string
}

/** One job row. */
export interface JobRow {
  readonly sourceId: string
  readonly jobId: string
  readonly name: string
  readonly schedule: string | null
  readonly lastRunAt: string | null
  readonly lastStatus: string | null
  readonly greenStreak: number
  readonly collectedAt: string
}

/** One health row. */
export interface HealthRow {
  readonly sourceId: string
  readonly state: string
  readonly latencyMs: number | null
  readonly checkedAt: string
  readonly consecutiveFailures: number
  readonly message: string | null
}

/** One event row (body values, decoded from the key). */
export interface EventRow {
  readonly at: string
  readonly subjectKey: string
  readonly kind: string
  readonly level: string
  readonly summary: string
  readonly index: number
}

/** The whole read model. */
export interface UiSnapshot {
  readonly at: string
  readonly community: { readonly pr: readonly PrRow[]; readonly issue: readonly IssueRow[] }
  readonly fleet: { readonly health: readonly HealthRow[]; readonly jobs: readonly JobRow[] }
  readonly ledger: readonly LedgerRow[]
  readonly events: readonly EventRow[]
  readonly missing: readonly string[]
  readonly truncated: boolean
}

/** Codes the `${}</>` of a snapshot body carries, so tests can prove the shape. */
export const LEDGER_KEYS = ['recordId', 'state', 'severity', 'count', 'lastSeen', 'analysisState'] as const

/** Collect one table's keyed rows, or null when the domain is not open. */
function keyedRowsOf<T>(table: Table<T> | undefined): Array<{ key: string; event: T }> | null {
  if (table === undefined) return null
  const out: Array<{ key: string; event: T }> = []
  for (const key of table.keys()) {
    const row = table.get(key)
    if (row !== undefined) out.push({ key, event: row })
  }
  return out
}

/** Collect one table's rows, or null when the domain is not open. */
function rowsOf<T>(table: Table<T> | undefined): T[] | null {
  if (table === undefined) return null
  const out: T[] = []
  for (const key of table.keys()) {
    const row = table.get(key)
    if (row !== undefined) out.push(row)
  }
  return out
}

/** Build the key a snapshot row reports (the storage key the page matches on). */
function keyOf(row: { platform: string; owner: string; repo: string; number: number }): string {
  return `${row.platform}/${row.owner}/${row.repo}/${String(row.number)}`
}

/**
 * Project the six tables into one snapshot.
 * @param tables - opened tables (`p7Tables(service)` hands them over).
 * @param now - generation instant (injected for tests).
 */
export function snapshotOf(tables: Partial<DomainTables>, now = new Date()): UiSnapshot {
  const missing: string[] = []

  const prRows = rowsOf(tables.pr)
  if (prRows === null) missing.push('workbench_snapshot_pr')
  const issueRows = rowsOf(tables.issue)
  if (issueRows === null) missing.push('workbench_snapshot_issue')
  const jobRows = rowsOf(tables.jobs)
  if (jobRows === null) missing.push('workbench_fleet_jobs')
  const errorRows = rowsOf(tables.errors)
  if (errorRows === null) missing.push('workbench_fleet_errors')
  const eventEntries = keyedRowsOf(tables.events)
  if (eventEntries === null) missing.push('workbench_events')
  const healthRows = rowsOf(tables.health)
  if (healthRows === null) missing.push('workbench_fleet_health')

  const pr: PrRow[] = (prRows ?? []).map((row) => ({
    key: keyOf(row),
    platform: row.platform,
    repo: `${row.owner}/${row.repo}`,
    number: row.number,
    title: maskSecrets(row.title),
    state: row.state,
    draft: row.draft,
    mergeability: row.mergeability,
    reviewDecision: row.reviewDecision,
    checksRollup: row.checksRollup,
    lastSeenAt: row.lastSeenAt,
  })).sort((left, right) => left.key.localeCompare(right.key))

  const issue: IssueRow[] = (issueRows ?? []).map((row) => ({
    key: keyOf(row),
    platform: row.platform,
    repo: `${row.owner}/${row.repo}`,
    number: row.number,
    title: maskSecrets(row.title),
    state: row.state,
    labels: row.labels,
    assignees: row.assignees,
    comments: row.comments,
    lastCommentBy: row.lastCommentBy,
    lastCommentAt: row.lastCommentAt,
    updatedAt: row.updatedAt,
  })).sort((left, right) => left.key.localeCompare(right.key))

  // Un-resolved first: the display order is fixed here and differs from the
  // contract declaration order on purpose (a record waiting on a repair is
  // what the reader opens first).
  const ORDER = ['open', 'reopened', 'analyzed', 'fix-applied', 'verified-resolved', 'closed-wontfix']
  const ledger: LedgerRow[] = (errorRows ?? []).map((row) => ({
    recordId: maskSecrets(row.recordId),
    state: row.state,
    severity: row.severity,
    count: row.count,
    lastSeen: row.lastSeen,
    analysisState: row.analysis.state,
  })).sort((left, right) =>
    ORDER.indexOf(left.state) - ORDER.indexOf(right.state) || right.lastSeen.localeCompare(left.lastSeen))

  const health: HealthRow[] = (healthRows ?? []).map((row) => ({
    sourceId: row.sourceId,
    state: row.state,
    latencyMs: row.latencyMs,
    checkedAt: row.checkedAt,
    consecutiveFailures: row.consecutiveFailures,
    message: row.message === null ? null : maskSecrets(row.message),
  })).sort((left, right) => left.sourceId.localeCompare(right.sourceId))

  const jobs: JobRow[] = (jobRows ?? []).map((row) => ({
    sourceId: row.sourceId,
    jobId: row.jobId,
    name: maskSecrets(row.name),
    schedule: row.schedule,
    lastRunAt: row.lastRunAt,
    lastStatus: row.lastStatus,
    greenStreak: row.greenStreak,
    collectedAt: row.collectedAt,
  })).sort((left, right) => `${left.sourceId}/${left.jobId}`.localeCompare(`${right.sourceId}/${right.jobId}`))

  const seen = (eventEntries ?? []).length > EVENT_LIMIT
  const events: EventRow[] = []
  for (const entry of eventEntries ?? []) {
    const decoded = decodeRow(entry.key, entry.event)
    if (decoded === null) continue
    events.push({
      at: entry.event.at,
      subjectKey: decoded.subjectKey,
      kind: entry.event.kind,
      level: entry.event.level,
      summary: maskSecrets(entry.event.summary),
      index: decoded.index,
    })
  }
  events.sort((left, right) => right.at.localeCompare(left.at))
  const kept = events.slice(0, EVENT_LIMIT)

  return {
    at: now.toISOString(),
    community: { pr, issue },
    fleet: { health, jobs },
    ledger,
    events: kept,
    missing,
    truncated: seen || JSON.stringify(kept).length > SNAPSHOT_MAX_BYTES,
  }
}

/**
 * Decode the storage key of one event row and check it against the body.
 * @param key - the `workbench_events` key (P6 encoded or P4/P5 literal).
 * @param event - the body stored under that key.
 * @returns the decoded segments, or null when the key disagrees with the body.
 */
export function decodeRow(key: string, event: ChangeEvent): { at: string; subjectKey: string; kind: string; index: number } | null {
  let decoded = decodeEventKey(key)
  if (decoded === null) {
    const parts = key.split('|')
    if (parts.length !== 4) return null
    const index = Number(parts[3])
    if (!Number.isInteger(index) || index <= 0) return null
    decoded = { at: parts[0] ?? '', subjectKey: parts[1] ?? '', kind: parts[2] ?? '', index }
  }
  if (decoded.at !== event.at || decoded.subjectKey !== event.subject.key || decoded.kind !== event.kind) return null
  return decoded
}

/**
 * Register the read-only snapshot route on the host web server.
 * @param ctx - row context (reads `webServer` when it is mounted).
 * @param provider - the snapshot source the route answers with.
 * @returns a synchronous disposer; registration itself happens on a microtask,
 *   and a disposer called first cancels it.
 */
export function mountP7(ctx: { get?: (key: string) => unknown }, provider?: () => UiSnapshot): () => void {
  let stopped = false
  let disposeRoute: (() => void) | undefined

  const build = () => {
    const webServer = ctx.get?.('webServer') as
      | { register(route: unknown): () => void; port?: number; host?: string }
      | undefined
    if (webServer === undefined || stopped) return
    const source = provider ?? (ctx.get?.('workbenchUiSnapshot') as (() => UiSnapshot) | undefined)
    const resource = async (): Promise<Response> =>
      new Response(JSON.stringify(source === undefined ? emptySnapshot() : source()), {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'x-workbench-route': 'resource',
        },
      })
    disposeRoute = webServer.register({ kind: 'exact', path: SNAPSHOT_PATH, resource })
  }

  void Promise.resolve()
    .then(() => {
      if (stopped) return
      build()
    })
    .catch(() => undefined)

  return () => {
    stopped = true
    if (disposeRoute !== undefined) {
      disposeRoute()
      disposeRoute = undefined
    }
  }
}

/** A snapshot with every domain missing (the host has not opened one yet). */
export function emptySnapshot(now = new Date()): UiSnapshot {
  return {
    at: now.toISOString(),
    community: { pr: [], issue: [] },
    fleet: { health: [], jobs: [] },
    ledger: [],
    events: [],
    missing: ['workbench_snapshot_pr', 'workbench_snapshot_issue', 'workbench_fleet_jobs', 'workbench_fleet_errors', 'workbench_events', 'workbench_fleet_health'],
    truncated: false,
  }
}
