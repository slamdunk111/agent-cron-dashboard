/**
 * The `workbench-notify` card kind and its skill text (P4, plan §3.3).
 *
 * dsh's action-card experiment only offers a card to an **online root agent**
 * that loaded the kind's skill itself, so the card is a proposal the model
 * makes, never something the background engine can pop on its own. The kind
 * definition below is what `ctx.actionCards.register()` needs; the text below
 * is the skill body published next to the bundle.
 */
import { z } from 'zod'

/** Action name the model proposes. */
export const NOTIFY_ACTION = 'workbench-notify'

/** Skill name the model must load before proposing. */
export const NOTIFY_SKILL = 'workbench-notify'

/** Fields of one card row. */
export const notifyEventRow = z.object({
  kind: z.string(),
  key: z.string(),
  summary: z.string(),
  at: z.string(),
})

/** `details` schema shared by host and client halves of the kind. */
export const notifyDetails = z.object({
  events: z.array(notifyEventRow),
  reason: z.enum(['live', 'backlog']),
})

/** Skill body: the instructions the model follows before proposing a card. */
export function skillText(): string {
  return [
    '# workbench notify',
    '',
    'The personal workbench turned community changes into graded events. A high-level',
    'event deserves one optional action card; medium events and first observations do not.',
    '',
    '## When to offer a card',
    '',
    '1. Call the `workbench_status` tool with `scope=community` to see the recent events.',
    '2. If it reports high-level events that have no card yet, call `propose_action` once:',
    `   - action: \`${NOTIFY_ACTION}\``,
    '   - title: the change in one line (for example `pr-ci-failed: owner/repo#12`).',
    '   - brief: what happened and what the user may want to do next.',
    '   - details: `{ "events": [{ "kind", "key", "summary", "at" }], "reason": "live" | "backlog" }`.',
    '3. When several events piled up while the host was offline, put them in **one** card and',
    '   set `reason` to `backlog`; never show one card per event.',
    '',
    '## What not to do',
    '',
    '- Do not offer a card for `pr-seeded` or `issue-seeded`: a first observation is digest material.',
    '- Do not repeat a card already offered for the same event.',
    '- Do not restate the card in your answer; the card is shown under it.',
  ].join('\n')
}

/**
 * The kind definition handed to `ctx.actionCards.register()`.
 * @returns the registration object (details schema + actions).
 */
export function notifyKind(): {
  action: string
  skill: string
  invitation: string
  details: typeof notifyDetails
  verbs: Record<string, never>
  act: (agent: unknown, proposal: { details: z.infer<typeof notifyDetails> }, verb: string) => Promise<{ result: string }>
} {
  return {
    action: NOTIFY_ACTION,
    skill: NOTIFY_SKILL,
    invitation: 'The card lets you open or dismiss the community change; ask briefly whether you want to handle it now.',
    details: notifyDetails,
    // The card is informative: the user dismisses it, nothing is written back
    // into GitHub/GitCode by this kind (write operations belong to P6/P7).
    verbs: {},
    act: async () => ({ result: 'noted' }),
  }
}
