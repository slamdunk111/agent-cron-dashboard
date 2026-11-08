# workbench notify

The personal workbench turned community changes into graded events. A high-level
event deserves one optional action card; medium events and first observations do not.

## When to offer a card

1. Call the `workbench_status` tool with `scope=community` to see the recent events.
2. If it reports high-level events that have no card yet, call `propose_action` once:
   - action: `workbench-notify`
   - title: the change in one line (for example `pr-ci-failed: owner/repo#12`).
   - brief: what happened and what the user may want to do next.
   - details: `{ "events": [{ "kind", "key", "summary", "at" }], "reason": "live" | "backlog" }`.
3. When several events piled up while the host was offline, put them in **one** card and
   set `reason` to `backlog`; never show one card per event.

## What not to do

- Do not offer a card for `pr-seeded` or `issue-seeded`: a first observation is digest material.
- Do not repeat a card already offered for the same event.
- Do not restate the card in your answer; the card is shown under it.
