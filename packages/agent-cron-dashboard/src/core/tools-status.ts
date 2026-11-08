/**
 * `workbench_status` — read-only summary tool (P4 v0, plan §3.5).
 *
 * The tool reads what is already stored: the event log domain, the community
 * snapshot tables and (from P5 on) the fleet tables. Nothing is polled here and
 * nothing is written, so the digest task can call it safely at 09:00.
 *
 * The fleet section is an explicit placeholder until P5/P6 land; the plan asks
 * for "fleet 未接入" rather than an empty panel that looks like a green fleet.
 */
import type { ChangeEvent } from '../../../../contracts/events.ts'

/** Storage surfaces the tool reads (all optional: a profile may lack some). */
export interface StatusSources {
  readonly events: { keys(): readonly string[]; get(key: string): ChangeEvent | undefined }
  readonly prCount: () => number
  readonly issueCount: () => number
  /** Fleet rows exist only from P5; `null` means "not wired yet". */
  readonly fleet: { readonly jobs: number; readonly errors: number; readonly sourcesUp?: number; readonly sourcesTotal?: number } | null
  readonly now?: () => Date
}

/** Scope argument of the tool. */
export type StatusScope = 'all' | 'community' | 'fleet'

/** Valid scope values (also the declared enum in the tool schema). */
export const STATUS_SCOPES: readonly StatusScope[] = ['all', 'community', 'fleet']

/** Result of one status call. */
export interface StatusReport {
  readonly text: string
  readonly stats: {
    readonly scope: StatusScope
    readonly since: string
    readonly high: number
    readonly medium: number
    readonly communitySnapshots: number
    readonly fleetJobs: number | null
    readonly unresolvedErrors: number | null
    readonly topKinds: readonly { readonly kind: string; readonly count: number }[]
  }
}

/** Default window: 24 hours before the call. */
export const STATUS_WINDOW_HOURS = 24

/**
 * Build the 24h summary text.
 * @param sources - stored data surfaces.
 * @param scope - `all` (default), `community` or `fleet`.
 * @param since - ISO 8601 floor; defaults to `now - 24h`.
 * @returns text plus the counts the text was built from (same source).
 */
export function buildStatus(sources: StatusSources, scope: StatusScope = 'all', since?: string): StatusReport {
  const now = (sources.now ?? (() => new Date()))()
  const floor = since ?? new Date(now.getTime() - STATUS_WINDOW_HOURS * 3_600_000).toISOString()
  const floorMs = Date.parse(floor)
  const events: ChangeEvent[] = []
  for (const key of sources.events.keys()) {
    const event = sources.events.get(key)
    if (event === undefined) continue
    if (scope === 'community' && event.subject.scope !== 'community') continue
    if (scope === 'fleet' && event.subject.scope !== 'fleet') continue
    if (Number.isFinite(floorMs) && Date.parse(event.at) < floorMs) continue
    events.push(event)
  }
  const wanted = scope === 'community' ? events : events
  const high = wanted.filter((event) => event.level === 'high').length
  const medium = wanted.filter((event) => event.level === 'medium').length
  const counts = new Map<string, number>()
  for (const event of wanted) counts.set(event.kind, (counts.get(event.kind) ?? 0) + 1)
  const topKinds = [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1))
    .slice(0, 5)
    .map(([kind, count]) => ({ kind, count }))
  const lines: string[] = []
  lines.push(`workbench status scope=${scope} since=${floor}`)
  lines.push(`events: ${String(wanted.length)} in window (high ${String(high)}, medium ${String(medium)})`)
  lines.push(
    topKinds.length === 0
      ? 'top kinds: none'
      : `top kinds: ${topKinds.map((entry) => `${entry.kind}×${String(entry.count)}`).join(', ')}`,
  )
  for (const event of wanted.slice(-5)) lines.push(`- ${event.at} ${event.kind} [${event.level}] ${event.subject.key}: ${event.summary}`)
  if (scope !== 'fleet') {
    lines.push(`community: ${String(sources.prCount())} PR snapshot(s), ${String(sources.issueCount())} issue snapshot(s)`)
  }
  if (scope !== 'community') {
    lines.push(
      sources.fleet === null
        ? 'fleet: not wired yet (P5 unimplemented; error ledger lands in P6)'
        : `fleet: ${String(sources.fleet.jobs)} job(s), ${String(sources.fleet.errors)} error record(s)`,
    )
    if (sources.fleet !== null && sources.fleet.sourcesTotal !== undefined) {
      lines.push(`fleet health: ${String(sources.fleet.sourcesUp ?? 0)}/${String(sources.fleet.sourcesTotal)} source(s) up`)
    }
  }
  return {
    text: lines.join('\n'),
    stats: {
      scope,
      since: floor,
      high,
      medium,
      communitySnapshots: sources.prCount() + sources.issueCount(),
      fleetJobs: sources.fleet === null ? null : sources.fleet.jobs,
      unresolvedErrors: sources.fleet === null ? null : sources.fleet.errors,
      topKinds,
    },
  }
}

/** Tool name and description (the row registers it under this name). */
export const STATUS_TOOL = 'workbench_status'

/** Model-facing description. */
export const STATUS_DESCRIPTION =
  'Read-only workbench summary: community change events in a time window (PR/issue), snapshot counts, fleet jobs/errors and source health (P5); the error ledger detail lands in P6.'
