/**
 * Daily digest task lifecycle (P4, plan §3.4).
 *
 * The task is a `schedule` entry whose prompt asks the agent to call
 * `workbench_status`; `schedule` persists it across restarts, so the only job
 * this module has is to make it **exist exactly once and match the config**:
 * create when missing, update when the expression/time zone/prompt drifted,
 * delete when the digest is switched off or the host unmounts.
 *
 * The `schedule` service is optional on purpose: a headless profile may not
 * mount it, and then the digest is named `skipped` instead of failing the row.
 */
import type { ScheduleTiming } from './schedule-types.ts'

/** The slice of `ctx.schedule` this module calls (structural, so a stub fits). */
export interface SchedulePort {
  catalog(): Promise<readonly ScheduleTaskLike[]>
  create(request: { title: string; prompt: string; timing: ScheduleTiming; target?: { kind: 'new_once' | 'new' | 'session'; sessionId?: unknown } }): Promise<unknown>
  edit(request: { id: string; action: 'update'; patch: Record<string, unknown> } | { id: string; action: 'delete' }): Promise<unknown>
}

/** The parts of a stored task the digest inspects. */
export interface ScheduleTaskLike {
  readonly id: string
  readonly title: string
  readonly prompt: string
  readonly status?: 'active' | 'paused' | 'ended'
  readonly record?: {
    readonly kind?: string
    readonly expression?: string
    readonly timeZone?: string
  }
}

/** Outcome of one `ensureDigestTask` call. */
export type DigestAction = 'created' | 'updated' | 'unchanged' | 'deleted' | 'skipped' | 'disabled'

/** Options of {@link DigestController}. */
export interface DigestOptions {
  readonly enabled: boolean
  readonly cron: string
  readonly timeZone: string
  readonly taskTitle: string
  /** Absent when the profile does not mount `schedule`. */
  readonly schedule?: SchedulePort
  readonly log?: (line: string) => void
}

/** Total time window the digest prompt asks for. */
export const DIGEST_WINDOW_HOURS = 24

/** The prompt text of the digest task (plan §3.4, verbatim requirement). */
export function digestPrompt(): string {
  return 'Call the workbench_status tool and output the 24h summary: community changes, fleet health, and the top unresolved errors (fleet placeholders before P6).'
}

/** Longest title the schedule service accepts. */
const MAX_TITLE = 120

/**
 * Create/update/delete the digest task idempotently.
 *
 * Idempotency is the contract: a second call with the same config returns
 * `unchanged` and **never** calls `create` again (the smoke and the unit test
 * count the calls).
 */
export class DigestController {
  private readonly options: DigestOptions
  private readonly log: (line: string) => void
  /** The task id this controller owns (created or adopted). */
  private taskId: string | undefined

  constructor(options: DigestOptions) {
    this.options = options
    this.log = options.log ?? ((line: string) => console.log(line))
  }

  /** Current ownership, for the smoke. */
  get ownedId(): string | undefined {
    return this.taskId
  }

  /** The timing the config resolves to. */
  timing(): ScheduleTiming {
    return { kind: 'cron', cron: { expression: this.options.cron, time_zone: this.options.timeZone } }
  }

  /**
   * Bring the task in line with the config.
   * @returns the action taken (`created`/`updated`/`unchanged`/`disabled`/`skipped`).
   */
  async ensure(): Promise<DigestAction> {
    if (this.options.schedule === undefined) {
      this.log('digest skipped: the schedule service is not mounted in this profile')
      return 'skipped'
    }
    if (!this.options.enabled) return this.clear()
    const tasks = await this.options.schedule.catalog()
    const existing = tasks.filter((task) => task.title === this.options.taskTitle && task.status !== 'ended')
    if (existing.length === 0) {
      const title = this.options.taskTitle.slice(0, MAX_TITLE)
      await this.options.schedule.create({
        title,
        prompt: digestPrompt(),
        timing: this.timing(),
        target: { kind: 'new_once' },
      })
      this.taskId = title
      this.log(`digest enabled action=created title="${title}"`)
      return 'created'
    }
    const task = existing[0]
    this.taskId = task.id
    // Several tasks with the same title would deliver twice: keep the first,
    // delete the rest by name (still keyed by id, never a wildcard).
    for (const duplicate of existing.slice(1)) await this.options.schedule.edit({ id: duplicate.id, action: 'delete' })
    const matches =
      task.record?.kind === 'cron' &&
      task.record.expression === this.options.cron &&
      task.record.timeZone === this.options.timeZone &&
      task.prompt === digestPrompt()
    if (matches) {
      this.log(`digest enabled action=unchanged title="${this.options.taskTitle}" id=${task.id}`)
      return 'unchanged'
    }
    await this.options.schedule.edit({
      id: task.id,
      action: 'update',
      patch: { prompt: digestPrompt(), timing: this.timing(), active: true },
    })
    this.log(`digest enabled action=updated title="${this.options.taskTitle}" id=${task.id}`)
    return 'updated'
  }

  /**
   * Remove the task this controller owns (or every task with the configured
   * title, named one by one).
   * @returns `deleted` when a task was removed, `disabled` when nothing was there.
   */
  async clear(): Promise<DigestAction> {
    if (this.options.schedule === undefined) {
      this.log('digest skipped: the schedule service is not mounted in this profile')
      return 'skipped'
    }
    const tasks = await this.options.schedule.catalog()
    const doomed = tasks.filter((task) => task.title === this.options.taskTitle || (this.taskId !== undefined && task.id === this.taskId))
    if (doomed.length === 0) {
      this.log('digest disabled action=disabled (no task to delete)')
      return 'disabled'
    }
    for (const task of doomed) await this.options.schedule.edit({ id: task.id, action: 'delete' })
    this.taskId = undefined
    this.log(`digest disabled action=deleted title="${this.options.taskTitle}" count=${String(doomed.length)}`)
    return 'deleted'
  }
}

/** Build the controller from resolved row config. */
export function makeDigestController(options: {
  readonly notify: { readonly digest: { readonly enabled: boolean; readonly cron: string; readonly timeZone: string; readonly taskTitle: string } }
  readonly schedule?: SchedulePort
  readonly log?: (line: string) => void
}): DigestController {
  return new DigestController({
    enabled: options.notify.digest.enabled,
    cron: options.notify.digest.cron,
    timeZone: options.notify.digest.timeZone,
    taskTitle: options.notify.digest.taskTitle,
    schedule: options.schedule,
    log: options.log,
  })
}
