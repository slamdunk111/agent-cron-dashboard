#!/usr/bin/env node
/**
 * Real-machine smoke of the P4 change engine + notifier + digest task.
 *
 * Two segments, in this order:
 *
 * 1. **fake segment** (always): feeds the whole graded table (22 keys) through
 *    the shipped engine, then proves the four P4 acceptance behaviours on the
 *    stored paths — first observation never dispatched, `actionCards=false`
 *    stores only, an offline backlog becomes one card, and the digest task is
 *    created once then reported `unchanged`.
 * 2. **live segment** (unless `--no-live`): runs the shipped P3 smoke
 *    (`scripts/smoke-p3.mjs`, 5 minutes) as a child process and reports the
 *    rounds it produced. Its `issue` lines are the live read of this window.
 *
 * Every line the gate (`p4-gate-check.mjs`) parses is fixed here:
 *
 *   - `env TZ_OFFSET=… load=… nproc=… loads=<capture time>` / `env_state` / `env_end` (§9b)
 *   - `seed kind=<kind> level=<level> emitted=<true|false|n/a>` (one per frozen kind)
 *   - `pair <key> scope=<pr|issue> before=<null|present> at=…`
 *   - `event <key> kind=… level=… at=… dispatch=<card|digest> n=<index>`
 *   - `card action=workbench-notify events=<n> reason=<live|backlog> title="…"`
 *   - `digest enabled=<bool> action=<created|updated|unchanged|deleted|disabled|skipped> title="…"`
 *   - `notify_state actionCards=<bool> registered=<bool> backlog=<n> at=…`
 *   - `status scope=<s> since=… events=<n> text_len=<n> at=…`
 *   - `live <platform> ok=<bool> considered=<n> changed=<n> queued=<n> at=…` (forwarded from P3)
 *   - `P4_SMOKE_END`, then the gate driver appends `EXIT rc=`
 *
 * Usage:
 *   node scripts/smoke-p4.mjs --window-minutes=3
 *   node scripts/smoke-p4.mjs --no-live
 *   node scripts/smoke-p4.mjs --action-cards=on|off
 */
import { spawnSync } from 'node:child_process'
import { cpus, loadavg } from 'node:os'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const T0 = '2026-11-09T01:00:00.000Z'

function argOf(argv, name, fallback) {
  const index = argv.indexOf(name)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}

/** Discipline §9b: capture the environment before any timing is believed. */
function environmentHeader(at) {
  const loads = loadavg()
  const nproc = cpus().length
  const ratio = nproc === 0 ? 0 : loads[0] / nproc
  console.log(`env TZ_OFFSET=${new Date().getTimezoneOffset()} load=${loads.map((value) => value.toFixed(2)).join(',')} nproc=${nproc} loads=<${at}>`)
  console.log(ratio > 1 ? `env_state OVERLOADED ratio=${ratio.toFixed(3)} (readings are an upper bound only)` : `env_state OK ratio=${ratio.toFixed(3)}`)
  return ratio <= 1
}

/** Load the built bundle exactly as dsh mounts it (argv is restored like the P3 smoke). */
async function loadModule() {
  const saved = [...process.argv]
  const loaded = await import(resolve(ROOT, 'build/packages/agent-cron-dashboard/index.js'))
  process.argv.length = 0
  process.argv.push(...saved)
  return loaded
}

/** One PR snapshot. */
function pr(over = {}) {
  return {
    platform: 'github',
    owner: 'owner',
    repo: 'repo',
    number: 7,
    title: 'sample',
    state: 'open',
    draft: false,
    mergeability: 'mergeable',
    reviewDecision: 'none',
    checksRollup: 'pending',
    headSha: 'sha-1',
    updatedAt: T0,
    firstSeenAt: T0,
    lastSeenAt: T0,
    events: [],
    ...over,
  }
}

/** One issue snapshot. */
function issue(over = {}) {
  return {
    platform: 'github',
    owner: 'owner',
    repo: 'repo',
    number: 9,
    title: 'sample',
    state: 'open',
    labels: ['bug'],
    assignees: [],
    comments: 0,
    updatedAt: T0,
    lastCommentBy: null,
    lastCommentAt: null,
    firstSeenAt: T0,
    lastSeenAt: T0,
    events: [],
    ...over,
  }
}

/** The PR/issue pairs that exercise every community kind (one pair per kind). */
function seedPairs() {
  const key = 'github/owner/repo'
  const pairs = []
  const push = (scope, number, before, after) => pairs.push({ scope, key: `${key}/${String(number)}`, before, after })
  push('pr', 1, null, pr({ number: 1 }))
  push('pr', 2, pr({ number: 2 }), pr({ number: 2, state: 'merged' }))
  push('pr', 3, pr({ number: 3 }), pr({ number: 3, state: 'closed' }))
  push('pr', 4, pr({ number: 4 }), pr({ number: 4, mergeability: 'conflicting' }))
  push('pr', 5, pr({ number: 5 }), pr({ number: 5, checksRollup: 'failure' }))
  push('pr', 6, pr({ number: 6 }), pr({ number: 6, reviewDecision: 'changes-requested' }))
  push('pr', 7, pr({ number: 7, draft: true }), pr({ number: 7, draft: false }))
  push('pr', 8, pr({ number: 8 }), pr({ number: 8, checksRollup: 'success' }))
  push('pr', 9, pr({ number: 9 }), pr({ number: 9, updatedAt: '2026-11-09T02:00:00.000Z' }))
  push('issue', 10, null, issue({ number: 10 }))
  push('issue', 11, issue({ number: 11 }), issue({ number: 11, state: 'closed' }))
  push('issue', 12, issue({ number: 12, state: 'closed' }), issue({ number: 12 }))
  push('issue', 13, issue({ number: 13 }), issue({ number: 13, labels: ['bug', 'p1'] }))
  push('issue', 14, issue({ number: 14 }), issue({ number: 14, assignees: ['me'] }))
  push('issue', 15, issue({ number: 15 }), issue({ number: 15, comments: 2, lastCommentBy: 'someone' }))
  return pairs
}

/** In-memory engine tables (same surface the row hands the engine). */
function memoryTables() {
  const events = new Map()
  const prs = new Map()
  const issues = new Map()
  const cursors = new Map()
  return {
    events,
    prs,
    issues,
    cursors,
    eventsTable: { get: (key) => events.get(key), put: async (key, value) => void events.set(key, value) },
    prTable: { get: (key) => prs.get(key), put: async (key, value) => void prs.set(key, value) },
    issueTable: { get: (key) => issues.get(key), put: async (key, value) => void issues.set(key, value) },
    cursorsTable: { get: (key) => cursors.get(key), put: async (key, value) => void cursors.set(key, value), delete: async (key) => cursors.delete(key) },
  }
}

/** A schedule stub: records calls and returns its own tasks (offline, in-process). */
function scheduleStub() {
  const calls = []
  const tasks = []
  return {
    calls,
    tasks,
    port: {
      catalog: async () => [...tasks],
      create: async (request) => {
        calls.push('create')
        tasks.push({
          id: `t-${String(tasks.length + 1)}`,
          title: request.title,
          prompt: request.prompt,
          status: 'active',
          record: { kind: request.timing.kind, expression: request.timing.cron.expression, timeZone: request.timing.cron.time_zone },
        })
        return tasks.at(-1)
      },
      edit: async (request) => {
        calls.push(request.action)
        if (request.action === 'delete') {
          const at = tasks.findIndex((task) => task.id === request.id)
          if (at >= 0) tasks.splice(at, 1)
        }
        return { ok: true }
      },
    },
  }
}

/** Build the engine over {@link memoryTables} with a fixed clock. */
function engineOf(bundle, tables, ms) {
  return new bundle.ChangeEngine({
    events: tables.eventsTable,
    prTable: tables.prTable,
    issueTable: tables.issueTable,
    cursors: tables.cursorsTable,
    drainQueue: async () => [],
    me: 'me',
    now: () => new Date(ms),
    log: () => undefined,
  })
}

async function main(argv) {
  const startedAt = new Date().toISOString()
  const overlay = argOf(argv, '--action-cards', 'off')
  const noLive = argv.includes('--no-live')
  const windowMinutes = Number(argOf(argv, '--window-minutes', '3'))
  console.log(`smoke p4 start=${startedAt} action_cards=${overlay} live=${String(!noLive && windowMinutes > 0)} window_minutes=${String(windowMinutes)}`)
  if (!environmentHeader(startedAt)) {
    console.log('P4_SMOKE_END (aborted: environment overloaded)')
    return 3
  }
  const bundle = await loadModule()
  const tables = memoryTables()
  const schedule = { enabled: true, cron: '0 9 * * *', timeZone: 'Asia/Shanghai', taskTitle: 'workbench-digest', schedule: scheduleStub() }
  let nowMs = Date.parse(T0)

  // ---- segment 1: the graded table, one pair per kind -----------------------
  console.log(`step seed start=${new Date().toISOString()}`)
  const emitted = new Set()
  const engine = engineOf(bundle, tables, nowMs)
  for (const entry of seedPairs()) {
    const pair = { key: entry.key, before: entry.before, after: entry.after, at: T0 }
    console.log(`pair ${entry.key} scope=${entry.scope} before=${entry.before === null ? 'null' : 'present'} at=${T0}`)
    // Simulate the P2/P3 write side: the snapshot exists before the pair is graded.
    const scope = entry.scope
    if (scope === 'pr') tables.prs.set(entry.key, entry.after)
    else tables.issues.set(entry.key, entry.after)
    nowMs += 10_000
    const events = await engine.consumePair(pair, scope)
    for (const event of events) {
      emitted.add(event.kind)
      console.log(`event ${event.subject.key} kind=${event.kind} level=${event.level} at=${event.at} dispatch=${event.level === 'high' ? 'card' : 'digest'} n=${String(engine.eventCount)}`)
    }
  }
  const kinds = Object.keys(bundle.CHANGE_LEVELS)
  for (const kind of kinds) {
    const isFleet = bundle.FLEET_KINDS.includes(kind)
    console.log(`seed kind=${kind} level=${bundle.CHANGE_LEVELS[kind]} emitted=${isFleet ? 'n/a' : String(emitted.has(kind))}`)
  }
  console.log(`step seed done=${new Date().toISOString()} events=${String(engine.eventCount)} stored=${String(tables.events.size)}`)

  // ---- segment 2: first observation never dispatches ------------------------
  const notifier = new bundle.NotifyService({ actionCards: overlay === 'on', backlogMergeCount: 2, agentLive: () => false, log: () => undefined })
  for (const [, value] of tables.events) notifier.route(value)
  const dispatchedSeeded = [...tables.events.values()].filter((event) => bundle.FIRST_OBSERVATION_KINDS.includes(event.kind) && notifier.routeLabel(event) === 'card')
  console.log(`seeded dispatched=${String(dispatchedSeeded.length)} (must be 0) at=${new Date().toISOString()}`)

  // ---- segment 3: the aCards=false close-down path ---------------------------
  const closed = new bundle.NotifyService({ actionCards: false, agentLive: () => true, log: () => undefined })
  const high = [...tables.events.values()].filter((event) => event.level === 'high')
  for (const event of high) closed.route(event)
  console.log(`notify_state actionCards=${String(closed.state().actionCards)} registered=${String(closed.state().cardsRegistered)} backlog=${String(closed.state().pending)} at=${new Date().toISOString()}`)
  console.log(`关闭态：事件只落库 stored_high=${String(high.length)} dispatched=${String(closed.state().dispatched)} at=${new Date().toISOString()}`)

  // ---- segment 4: an offline backlog becomes one card ------------------------
  let live = false
  const backlogged = new bundle.NotifyService({ actionCards: true, backlogMergeCount: 2, agentLive: () => live, log: () => undefined })
  for (const event of high.slice(0, 3)) backlogged.route(event)
  live = true
  for (const card of backlogged.takeCards()) {
    console.log(`card action=${card.action} events=${String(card.details.events.length)} reason=${card.details.reason} title="${card.title}" at=${new Date().toISOString()}`)
  }

  // ---- segment 5: digest task created once, then unchanged -------------------
  const digest = new bundle.DigestController({ ...schedule, schedule: schedule.schedule.port })
  const created = await digest.ensure()
  console.log(`digest enabled=true action=${created} title="${schedule.taskTitle}" at=${new Date().toISOString()}`)
  const again = await digest.ensure()
  console.log(`digest enabled=true action=${again} title="${schedule.taskTitle}" at=${new Date().toISOString()} calls=${schedule.schedule.calls.join(',')}`)
  const disabled = await new bundle.DigestController({ ...schedule, enabled: false, schedule: schedule.schedule.port }).clear()
  console.log(`digest enabled=false action=${disabled} title="${schedule.taskTitle}" at=${new Date().toISOString()}`)

  // ---- segment 6: the status tool reads the same stored events --------------
  const report = bundle.buildStatus(
    {
      events: { keys: () => [...tables.events.keys()], get: (key) => tables.events.get(key) },
      prCount: () => tables.prs.size,
      issueCount: () => tables.issues.size,
      fleet: null,
    },
    'all',
    '2026-11-08T00:00:00.000Z',
  )
  console.log(`status scope=${report.stats.scope} since=${report.stats.since} events=${String(report.stats.high + report.stats.medium)} text_len=${String(report.text.length)} at=${new Date().toISOString()}`)

  // ---- segment 7: the live window (P3 smoke as a child) ---------------------
  let liveRounds = 0
  if (!noLive && windowMinutes > 0) {
    console.log(`step live start=${new Date().toISOString()} child=scripts/smoke-p3.mjs`)
    const run = spawnSync(process.execPath, [resolve(ROOT, 'scripts/smoke-p3.mjs'), '--window-minutes', String(windowMinutes), '--tick-seconds', '30'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: (windowMinutes + 5) * 60_000,
      maxBuffer: 64 * 1024 * 1024,
    })
    const text = `${run.stdout ?? ''}${run.stderr ?? ''}`
    for (const line of text.split('\n')) {
      // Forward the round lines (the live read of this window) verbatim.
      const match = /^issue (github|gitcode) ok=(true|false) considered=(\d+) changed=(\d+) queued=(\d+) at=([0-9T:.Z-]+)/.exec(line)
      if (match !== null) {
        liveRounds += 1
        console.log(`live ${match[1]} ok=${match[2]} considered=${match[3]} changed=${match[4]} queued=${match[5]} at=${match[6]}`)
      }
      // Keep the environment denominator of the child too (same §9b rule).
      if (line.startsWith('env_state ')) console.log(`live_child ${line}`)
      if (line.startsWith('health community:issue:gitcode')) console.log(`live_child ${line}`)
    }
    console.log(`step live done=${new Date().toISOString()} rc=${String(run.status ?? -1)} rounds=${String(liveRounds)}`)
  } else {
    console.log(`step live skipped=${new Date().toISOString()} reason=--no-live|window=0`)
  }

  const endAt = new Date().toISOString()
  console.log(`env_end loads=<${endAt}>`)
  console.log(`P4_SMOKE_END events=${String(engine.eventCount)} stored=${String(tables.events.size)}`)
  return 0
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error('smoke p4 failed:', error instanceof Error ? error.stack : error)
    process.exit(1)
  })
