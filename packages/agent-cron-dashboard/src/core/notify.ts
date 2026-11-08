/**
 * Notification routing (P4, plan §3.3; design §6).
 *
 * Only `level` routes: `high` events become card proposals, `medium` events
 * (and every first-observation kind) only feed the digest. Two rules come
 * straight from the batch constraints:
 *
 * - ADR P2-1 / P3-1: a first-observation kind is **never dispatched**, whatever
 *   a future table edit says;
 * - the dsh action-card experiment only shows a card to an **online root
 *   agent** that loaded the kind's skill by itself, so a background event
 *   cannot pop a card on its own. The engine therefore records the proposal
 *   (`pendingCards()`) and the shipped skill instructs the model to offer it;
 *   when the host is offline the proposals pile up and are handed over as **one**
 *   aggregated card on the next live turn.
 */
import type { ChangeEvent, ChangeKind } from '../../../../contracts/events.ts'
import { CHANGE_LEVELS } from '../../../../contracts/events.ts'
import { isFirstObservation } from './grade.ts'

/** One card the notifier wants the model to offer. */
export interface CardProposal {
  readonly action: 'workbench-notify'
  /** Title shown on the card. */
  readonly title: string
  /** One line describing what the card is about. */
  readonly brief: string
  readonly details: {
    /** Events the card groups (aggregated when the host was offline). */
    readonly events: readonly { readonly kind: string; readonly key: string; readonly summary: string; readonly at: string }[]
    /** `backlog`: produced while no root agent was live. */
    readonly reason: 'live' | 'backlog'
  }
}

/** Options of {@link NotifyService}. */
export interface NotifyOptions {
  /** `notify.actionCards`; false turns every card into a stored-only event. */
  readonly actionCards: boolean
  /** Whether an online root agent can receive a card right now. */
  readonly agentLive?: () => boolean
  /** Backlog threshold: fewer pending high events than this stay individual. */
  readonly backlogMergeCount?: number
  readonly now?: () => Date
  readonly log?: (line: string) => void
}

/** What the smoke and the status tool read back. */
export interface NotifyState {
  readonly actionCards: boolean
  readonly cardsRegistered: boolean
  readonly pending: number
  readonly backlog: number
  readonly dispatched: number
  readonly digestOnly: number
}

/** Events the digest reads (the log domain). */
export interface EventLogReader {
  read(since: string, scope?: 'community' | 'fleet'): Promise<readonly ChangeEvent[]>
}

/** Where high events go: `card` (proposal pending), `digest` (never a card). */
export type Route = 'card' | 'digest'

/**
 * Routes engine events and keeps the pending-card ledger.
 *
 * The ledger is in memory on purpose: a card is a *conversation* artifact, and
 * the durable copy of every event is already in `workbench.events`; after a
 * restart the digest and the status tool still see everything.
 */
export class NotifyService {
  private readonly options: NotifyOptions
  private readonly log: (line: string) => void
  private readonly pending: { event: ChangeEvent; live: boolean }[] = []
  private dispatchedCount = 0
  private digestOnlyCount = 0
  private registered = false

  constructor(options: NotifyOptions) {
    this.options = options
    this.log = options.log ?? ((line: string) => console.log(line))
  }

  /** Record that the action-card kind is registered on this host. */
  markRegistered(registered: boolean): void {
    this.registered = registered
    if (!registered) this.log('notify: action-cards service is not mounted; cards are recorded as proposals only')
  }

  /** Read back the routing state (smoke + `workbench_status`). */
  state(): NotifyState {
    const backlog = this.pending.filter((entry) => !entry.live).length
    return {
      actionCards: this.options.actionCards,
      cardsRegistered: this.registered,
      pending: this.pending.length,
      backlog,
      dispatched: this.dispatchedCount,
      digestOnly: this.digestOnlyCount,
    }
  }

  /**
   * Route one graded event.
   * @param event - the event the engine produced.
   * @returns where it went (see {@link Route}).
   */
  route(event: ChangeEvent): Route {
    // First observation is digest material even if `level` were ever changed.
    if (isFirstObservation(event.kind) || CHANGE_LEVELS[event.kind as ChangeKind] === 'medium') {
      this.digestOnlyCount += 1
      return 'digest'
    }
    if (!this.options.actionCards) {
      // Named off-switch: stored, never carded; the digest still reports it.
      this.log(`notify actionCards=false: high event ${event.kind} ${event.subject.key} stored only (关闭态：事件只落库)`)
      this.digestOnlyCount += 1
      return 'digest'
    }
    const live = this.options.agentLive?.() ?? false
    // `live=false` is the backlog marker: this event was raised while no root
    // agent could take a card, and it is handed over on the next live turn.
    this.pending.push({ event, live })
    this.dispatchedCount += 1
    return 'card'
  }

  /** Why an event went where it went, for the smoke's `event … dispatch=` field. */
  routeLabel(event: ChangeEvent): string {
    return isFirstObservation(event.kind) || CHANGE_LEVELS[event.kind as ChangeKind] === 'medium' ? 'digest' : this.options.actionCards ? 'card' : 'digest'
  }

  /**
   * Take the cards the model should offer now.
   * @returns one aggregated backlog card (when enough piled up) then the live
   * ones in arrival order; an empty list when the host is not live.
   */
  takeCards(): CardProposal[] {
    const live = this.options.agentLive?.() ?? false
    if (!live) return []
    const floor = this.options.backlogMergeCount ?? 2
    const backlog = this.pending.filter((entry) => !entry.live).map((entry) => entry.event)
    const fresh = this.pending.filter((entry) => entry.live).map((entry) => entry.event)
    this.pending.length = 0
    const out: CardProposal[] = []
    if (backlog.length >= floor) out.push(this.backlogCard(backlog))
    else out.push(...backlog.map((event) => this.singleCard(event, 'backlog')))
    out.push(...fresh.map((event) => this.singleCard(event)))
    return out
  }

  /** Number of high events still waiting for a card. */
  get pendingCount(): number {
    return this.pending.length
  }

  /** One card for a single event. */
  private singleCard(event: ChangeEvent, reason: 'live' | 'backlog' = 'live'): CardProposal {
    return {
      action: 'workbench-notify',
      title: `${event.kind}: ${event.subject.label}`,
      brief: event.summary,
      details: { events: [this.row(event)], reason },
    }
  }

  /** The aggregated "期间 N 事件" card (plan §3.3). */
  private backlogCard(events: readonly ChangeEvent[]): CardProposal {
    const shown = events.slice(-20)
    return {
      action: 'workbench-notify',
      title: `workbench: ${String(events.length)} events while offline`,
      brief: `期间 ${String(events.length)} 事件（离线积压聚合）`,
      details: { events: shown.map((event) => this.row(event)), reason: 'backlog' },
    }
  }

  private row(event: ChangeEvent): { kind: string; key: string; summary: string; at: string } {
    return { kind: event.kind, key: event.subject.key, summary: event.summary, at: event.at }
  }

  /** Text of the pending cards, in the form the skill tells the model to use. */
  renderCards(): string {
    const cards = this.takeCards()
    if (cards.length === 0) return 'no pending card'
    return cards
      .map((card) => `action=${card.action} title="${card.title}" details=${JSON.stringify(card.details)}`)
      .join('\n')
  }
}

/**
 * Read the event log domain for the digest and the status tool.
 * @param events - table surface (`get` per key; keys are read from the listing).
 * @returns a reader over the stored events.
 */
export function makeEventLog(events: {
  keys(): readonly string[]
  get(key: string): ChangeEvent | undefined
}): EventLogReader {
  return {
    async read(since: string, scope?: 'community' | 'fleet'): Promise<readonly ChangeEvent[]> {
      const floor = Date.parse(since)
      const out: ChangeEvent[] = []
      for (const key of events.keys()) {
        const event = events.get(key)
        if (event === undefined) continue
        if (scope !== undefined && event.subject.scope !== scope) continue
        if (Number.isFinite(floor) && Date.parse(event.at) < floor) continue
        out.push(event)
      }
      return out.sort((left, right) => (left.at < right.at ? -1 : left.at > right.at ? 1 : 0))
    },
  }
}
