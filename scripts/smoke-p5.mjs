#!/usr/bin/env node
/**
 * P5 smoke: replay the fleet adapters against measured fixtures, then read the
 * three real sources (NAS over ssh, the local jiuwenswarm service, and one
 * deliberately broken ssh host) for `--rounds` rounds.
 *
 * Every line the gate (`p5-gate-check.mjs`) parses is fixed here:
 *
 *   env TZ_OFFSET=… load=… nproc=… loads=<time>` / `env_state` / `env_end`      (§9b)
 *   replay source=<id> jobs=<n> runs=<n> errors=<n>                    (fixture replay)
 *   replay_event kind=<kind> key=<key>                    (replay graded keys, frozen 7)
 *   nas round=<n> rc=<0> jobs=<n> runs=<n> script_error=<k> cursor=<maxId> errors=<n> at=<ISO>
 *   gmk round=<n> rc=<0> health=<up|down> jobs=<n> runs=<n> errors=<n> at=<ISO>
 *   bad round=<n> health=down failures=<n> backoff=<ms> at=<ISO>
 *   fleet_event kind=<kind> key=<key> level=<level> at=<ISO>
 *   status scope=<s> events=<n> fleet="<text>" text_len=<n> at=<ISO>
 *   p5_smoke_end
 *
 * Usage:
 *   node scripts/smoke-p5.mjs [--rounds N] [--no-live] [--inject-failure]
 */
import { execFile } from 'node:child_process'
import { readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { cpus, loadavg } from 'node:os'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const HANDOFF = resolve(ROOT, '../docs/handoff')

/** ISO timestamp in +08:00 (the owner's zone); every gate line uses one zone. */
function stamp(at = new Date()) {
  const value = at instanceof Date ? at : new Date(at)
  const shifted = new Date(value.getTime() + 8 * 3_600_000)
  return `${shifted.toISOString().replace('Z', '+08:00')}`
}

/** Discipline §9b: capture the environment before anything timing-related. */
function environmentHeader(at) {
  const loads = loadavg()
  const nproc = cpus().length
  const ratio = nproc === 0 ? 0 : loads[0] / nproc
  console.log(`env TZ_OFFSET=${String(new Date().getTimezoneOffset())} load=${loads.map((v) => v.toFixed(2)).join(',')} nproc=${String(nproc)} loads=<${stamp(at)}>`)
  console.log(ratio > 1 ? `env_state OVERLOADED ratio=${ratio.toFixed(3)} (readings are an upper bound only)` : `env_state OK ratio=${ratio.toFixed(3)}`)
  return ratio <= 1
}

function argOf(argv, name, fallback) {
  const index = argv.indexOf(name)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}

/** Load the built bundle the way the adapters run in production. */
async function loadBundle() {
  const saved = [...process.argv]
  const loaded = await import(resolve(ROOT, 'build/packages/agent-cron-dashboard/index.js'))
  process.argv.length = 0
  process.argv.push(...saved)
  return loaded
}

/** Run one process and collect stdout/stderr (bounded wait). */
function run(command, args, timeoutMs = 60_000, extraEnv = {}) {
  return new Promise((res) => {
    execFile(command, args, { timeout: timeoutMs, env: { ...process.env, ...extraEnv }, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      res({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1, stdout: stdout ?? '', stderr: stderr ?? '' })
    })
  })
}

/** Real spawner for the SSH executor (the adapters go through the whitelist first). */
function spawnProcess(command, args, timeoutMs, signal) {
  return new Promise((res, rej) => {
    const child = execFile(command, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, signal }, (error, stdout, stderr) => {
      if (error !== null && error.killed === true) {
        res({ code: -1, stdout: stdout ?? '', stderr: stderr ?? '' })
        return
      }
      res({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1, stdout: stdout ?? '', stderr: stderr ?? '' })
    })
    child.on('error', rej)
  })
}

/** Read a tail window from one local file. */
function tailFile(path, bytes) {
  try {
    const size = statSync(path).size
    const start = Math.max(0, size - bytes)
    const fd = openSync(path, 'r')
    try {
      const buffer = Buffer.alloc(size - start)
      readSync(fd, buffer, 0, buffer.length, start)
      return buffer.toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return ''
  }
}

/** Local file surface for the jiuwenswarm adapter (read-only; SQL through a `mode=ro` URI). */
function localFiles() {
  return {
    tail: async (path, bytes) => ({ code: 0, text: tailFile(path, bytes) }),
    stat: async (path) => {
      try {
        const s = statSync(path)
        return { code: 0, text: `${String(s.dev)} ${String(s.ino)} ${String(s.size)}` }
      } catch {
        return { code: 2, text: '' }
      }
    },
    list: async (path) => {
      try {
        return { code: 0, names: readdirSync(path) }
      } catch {
        return { code: 2, names: [] }
      }
    },
    sqlite: async (dbPath, sql) => {
      const result = await run('sqlite3', ['-readonly', '-json', `file:${dbPath}?mode=ro`, sql])
      return { code: result.code, text: result.stdout }
    },
  }
}

/** systemd user unit probe with the bus environment filled in. */
function systemdProbe() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000
  const env = { XDG_RUNTIME_DIR: `/run/user/${String(uid)}`, DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${String(uid)}/systemd/private` }
  return {
    isActive: async () => {
      const result = await run('systemctl', ['--user', 'is-active', 'jiuwenswarm.service'], 15_000, env)
      const out = result.stdout.trim()
      return { active: result.code === 0 && out === 'active', message: result.code === 0 ? null : `systemctl returned ${out || String(result.code)}` }
    },
  }
}

/** In-memory tables so a round leaves no state behind on disk. */
function memoryTables() {
  const jobs = new Map()
  const cursors = new Map()
  const health = new Map()
  const events = new Map()
  return {
    jobs,
    cursors,
    health,
    events,
    api: {
      jobs: { get: (k) => jobs.get(k), put: async (k, v) => void jobs.set(k, v), keys: () => [...jobs.keys()] },
      cursors: { get: (k) => cursors.get(k), put: async (k, v) => void cursors.set(k, v) },
      health: { get: (k) => health.get(k), put: async (k, v) => void health.set(k, v), keys: () => [...health.keys()] },
      events: { get: (k) => events.get(k), put: async (k, v) => void events.set(k, v) },
    },
  }
}

/** The fixture replay: every adapter over the measured samples (§probes). */
async function replay(bundle) {
  const replayDoc = JSON.parse(readFileSync(resolve(ROOT, 'fixtures/fleet/p5-replay.json'), 'utf8'))
  const hermesJobsText = JSON.stringify(replayDoc.sources.hermes.jobs_json)
  const eventsText = JSON.stringify([
    { id: 1, job_id: '68f64ca3b0b1', event_type: 'run', status: null, detail: null, occurred_at: '2026-09-28T17:20:21+08:00' },
    { id: 2, job_id: '68f64ca3b0b1', event_type: 'script_error', status: null, detail: 'Blocked: script path resolves outside the scripts directory', occurred_at: '2026-09-28T17:20:21+08:00' },
    { id: 3, job_id: '2d4f5e1bbf08', event_type: 'run', status: null, detail: null, occurred_at: '2026-09-28T17:22:00+08:00' },
  ])
  const logLines = replayDoc.sources.hermes.errors_log.lines.map((line) => `${line.ts} ${line.level} ${line.logger}: ${line.message}`).join('\n')
  const remoteAnswers = (read) => {
    const out =
      read.kind === 'stat' ? (read.path.endsWith('jobs.json') ? String(hermesJobsText.length) : `1 2 ${String(logLines.length)}`) :
      read.kind === 'wc-c' ? `${String(logLines.length)}` :
      read.kind === 'tail-bytes' ? (read.path.endsWith('jobs.json') ? hermesJobsText : logLines) :
      eventsText
    return out
  }
  const hermes = new bundle.HermesSshAdapter({
    config: { id: 'hermes-nas', kind: 'hermes-ssh', ssh: { host: 'nas', dbPath: '/root/.hermes/state.db', errorsLog: '/root/.hermes/logs/errors.log' } },
    run: async (read) => ({ code: 0, stdout: remoteAnswers(read), stderr: '' }),
  })
  const jobs = await hermes.listJobs()
  const runs = await hermes.fetchRuns(null)
  const errors = await hermes.fetchErrorEntries(null)
  console.log(`replay source=${hermes.id} jobs=${String(jobs.length)} runs=${String(runs.runs.length)} errors=${String(errors.entries.length)}`)
  const failed = runs.runs.filter((entry) => entry.status === 'failed')
  console.log(`replay script_error=${String(failed.length)} exit_detail_present=${String(failed.length > 0 && failed[0].exitDetail !== undefined)}`)
  // Machine-source numbers the judge compares against the fixture file (no hand-transcribed counts).
  const fixtureCounts = {
    hermes_jobs: replayDoc.sources.hermes.jobs_json.jobs.length,
    hermes_metrics: replayDoc.sources.hermes.metrics.length,
    hermes_errors: replayDoc.sources.hermes.errors_log.lines.length,
    jw_jobs: replayDoc.sources.jiuwenswarm.cron_jobs.jobs.length,
    jw_runs: replayDoc.sources.jiuwenswarm.run_ledger.rows.length,
    jw_metrics: replayDoc.sources.jiuwenswarm.error_landing.tool_log_error_lines.length,
  }

  const jwDoc = replayDoc.sources.jiuwenswarm
  const jw = new bundle.JiuwenswarmLocalAdapter({
    config: { id: 'jiuwen-gmk', kind: 'jiuwenswarm-local', paths: { state: '/tmp/jw-state' } },
    service: { isActive: async () => ({ active: true, message: null }) },
    files: {
      tail: async (path) =>
        path.endsWith('cron_jobs.json') ? { code: 0, text: JSON.stringify(jwDoc.cron_jobs) } :
        path.endsWith('tool.log') ? { code: 0, text: jwDoc.error_landing.tool_log_error_lines.map((line) => `${line.ts} | ${line.module} | default_trace_id | ${line.level} | {"message":"${line.message}"}`).join('\n') } :
        { code: 0, text: '' },
      stat: async (path) => ({ code: 0, text: path.endsWith('tool.log') ? `1 7 ${String(32)}` : `1 8 ${String(0)}` }),
      list: async (path) => ({ code: 0, names: path.endsWith('worker-logs') ? ['runtime-worker-a.stderr.log'] : [] }),
      sqlite: async () => ({ code: 0, text: JSON.stringify(jwDoc.run_ledger.rows) }),
    },
  })
  const jwJobs = await jw.listJobs()
  const jwRuns = await jw.fetchRuns(null)
  const jwErrors = await jw.fetchErrorEntries(null)
  console.log(`replay source=${jw.id} jobs=${String(jwJobs.length)} runs=${String(jwRuns.runs.length)} errors=${String(jwErrors.entries.length)}`)
  console.log(`replay numbers hermes_jobs=${String(jobs.length)}/${String(fixtureCounts.hermes_jobs)} jw_jobs=${String(jwJobs.length)}/${String(fixtureCounts.jw_jobs)} jw_runs=${String(jwRuns.runs.length)}/${String(fixtureCounts.jw_runs)}`)

  // The four P5 keys through the watch's own grading on a memory table set.
  const { FleetWatchService } = bundle
  const t = memoryTables()
  const scripted = [
    { jobs: [{ id: 'job-a', name: 'job-a', schedule: '20 * * * *', script: null, lastRunAt: null, lastStatus: null }], runs: [{ jobId: 'job-a', startedAt: '2026-11-08T10:00:00+08:00', status: 'ok' }], health: { sourceId: 'replay', state: 'up', latencyMs: 1, checkedAt: '2026-11-08T10:00:00.000Z', message: null, consecutiveFailures: 0 } },
    { jobs: [{ id: 'job-a', name: 'job-a', schedule: '20 * * * *', script: null, lastRunAt: null, lastStatus: null }], runs: [{ jobId: 'job-a', startedAt: '2026-11-08T11:00:00+08:00', status: 'failed' }], health: { sourceId: 'replay', state: 'down', latencyMs: 1, checkedAt: '2026-11-08T11:00:00.000Z', message: 'ssh refused', consecutiveFailures: 1 } },
    { jobs: [{ id: 'job-a', name: 'job-a', schedule: '20 * * * *', script: null, lastRunAt: null, lastStatus: null }], runs: [{ jobId: 'job-a', startedAt: '2026-11-08T12:00:00+08:00', status: 'ok' }], health: { sourceId: 'replay', state: 'up', latencyMs: 1, checkedAt: '2026-11-08T12:00:00.000Z', message: null, consecutiveFailures: 0 } },
  ]
  let round = 0
  const fakeSource = {
    id: 'replay',
    kind: 'hermes-ssh',
    listJobs: async () => scripted[Math.min(round, 2)].jobs,
    fetchRuns: async () => ({ runs: scripted[Math.min(round, 2)].runs, cursor: { token: String(round) } }),
    fetchErrorEntries: async () => ({ entries: [], cursor: { token: String(round) } }),
    health: async () => { const value = scripted[Math.min(round, 2)].health; round += 1; return value },
  }
  const watch = new FleetWatchService({ sources: [fakeSource], tables: t.api, autoStart: false })
  await watch.runOnce()
  await watch.runOnce()
  await watch.runOnce()
  for (const event of t.events.values()) console.log(`replay_event kind=${event.kind} key=${event.subject.key} level=${event.level}`)
  return t
}

/** One live round over the three real sources. */
async function liveRound(bundle, round, opts) {
  const { makeRunRemote, HermesSshAdapter, JiuwenswarmLocalAdapter, GenericSshSqliteAdapter } = bundle
  const remote = makeRunRemote({ host: 'nas', connectTimeoutSec: 10 }, { spawn: spawnProcess }, 40_000)
  const hermes = new HermesSshAdapter({ config: { id: 'hermes-nas', kind: 'hermes-ssh', ssh: { host: 'nas', dbPath: '/root/.hermes/state.db', errorsLog: '/root/.hermes/logs/errors.log' } }, run: remote })
  const started = Date.now()
  let line = `nas round=${String(round)}`
  try {
    const jobs = await hermes.listJobs()
    const runs = await hermes.fetchRuns(null)
    const errors = await hermes.fetchErrorEntries(null)
    const scriptErrors = runs.runs.filter((entry) => entry.status === 'failed').length
    const cursor = JSON.parse(runs.cursor.token).runs ?? 0
    line += ` rc=0 jobs=${String(jobs.length)} runs=${String(runs.runs.length)} script_error=${String(scriptErrors)} cursor=${String(cursor)} errors=${String(errors.entries.length)}`
  } catch (error) {
    line += ` rc=1 jobs=0 runs=0 script_error=0 cursor=0 errors=0 message="${String(error instanceof Error ? error.message : error).slice(0, 80)}"`
  }
  console.log(`${line} at=${stamp()} ms=${String(Date.now() - started)}`)

  const jw = new JiuwenswarmLocalAdapter({
    config: { id: 'jiuwen-gmk', kind: 'jiuwenswarm-local', paths: { state: `${process.env.HOME ?? ''}/.jiuwenswarm` } },
    files: localFiles(),
    service: systemdProbe(),
  })
  const jwStarted = Date.now()
  let gmkLine = `gmk round=${String(round)}`
  try {
    const health = await jw.health()
    const jobs = await jw.listJobs()
    const runs = await jw.fetchRuns(null)
    const errors = await jw.fetchErrorEntries(null)
    gmkLine += ` rc=0 health=${health.state} jobs=${String(jobs.length)} runs=${String(runs.runs.length)} errors=${String(errors.entries.length)}`
  } catch (error) {
    gmkLine += ` rc=1 health=down jobs=0 runs=0 errors=0 message="${String(error instanceof Error ? error.message : error).slice(0, 80)}"`
  }
  console.log(`${gmkLine} at=${stamp()} ms=${String(Date.now() - jwStarted)}`)

  if (opts.injectFailure && round === 1) {
    // A host that does not exist: the round must report down without touching the others.
    const bad = makeRunRemote({ host: 'nas-does-not-exist', connectTimeoutSec: 4 }, { spawn: spawnProcess }, 15_000)
    const probe = new HermesSshAdapter({ config: { id: 'bad', kind: 'hermes-ssh', ssh: { host: 'nas-does-not-exist', dbPath: '/root/.hermes/state.db' } }, run: bad })
    const failures = 1
    const health = await probe.health()
    const backoff = bundle.backoffFor(failures, 300_000, 3_600_000)
    console.log(`bad round=${String(round)} health=${health.state} failures=${String(failures)} backoff=${String(backoff)} at=${stamp()}`)
  }
}

/** Status tool text over the replay tables (fleet section real numbers). */
function statusLine(bundle, tables, round = 0) {
  const report = bundle.buildStatus(
    { events: { keys: () => [...tables.events.keys()], get: (k) => tables.events.get(k) }, prCount: () => 0, issueCount: () => 0, fleet: { jobs: tables.jobs.size, errors: 0, sourcesUp: tables.health.size, sourcesTotal: tables.health.size } },
    'fleet',
  )
  const fleetLine = report.text.split('\n').find((line) => line.startsWith('fleet:')) ?? ''
  console.log(`status scope=fleet events=${String(report.stats.high + report.stats.medium)} fleet="${fleetLine}" text_len=${String(report.text.length)} round=${String(round)} at=${stamp()}`)
}

async function main(argv) {
  const startedAt = new Date().toISOString()
  const rounds = Number(argOf(argv, '--rounds', '1'))
  const noLive = argv.includes('--no-live')
  const injectFailure = argv.includes('--inject-failure')
  console.log(`smoke p5 start=${stamp(startedAt)} rounds=${String(rounds)} live=${String(!noLive && rounds > 0)} inject_failure=${String(injectFailure)}`)
  const healthy = environmentHeader(startedAt)
  if (!healthy) {
    console.log('ENV_OVERLOADED: readings are an upper bound only; the gate treats this run as not-passing')
    console.log('p5_smoke_end')
    return 3
  }
  const bundle = await loadBundle()
  const tables = await replay(bundle)
  // Offline run: the replay is the whole window. Live runs print one status line per round.
  if (noLive || rounds <= 0) statusLine(bundle, tables)
  if (!noLive && rounds > 0) {
    for (let round = 1; round <= rounds; round += 1) {
      await liveRound(bundle, round, { injectFailure })
      statusLine(bundle, tables, round)
    }
  } else {
    console.log(`step live skipped=${new Date().toISOString()} reason=--no-live|rounds=0`)
  }
  console.log(`env_end at=${stamp()}`)
  console.log('p5_smoke_end')
  return 0
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code
})
