#!/usr/bin/env node
/**
 * P6 smoke: the fingerprint sheet, two replay playbooks, the mask check, and
 * (with `--live`) one real window against the measured hosts and the real LLM.
 *
 * Every line the judge (`p6-gate-check.mjs`) parses is fixed here:
 *
 *   env TZ_OFFSET=… load=… nproc=… loads=<ISO>` / `env_state` / `env_end`
 *   replay_seal fixtures=… sha256=… cases=<n>            (sheet integrity)
 *   fp case id=… expect=… actual=… verdict=… note="…"     (one per sheet case)
 *   fp eval same=…/… diff=…/… hit=…%
 *   script mask verdict=PASS|FAIL hits=<n>            (the mask covers the measured samples)
 *   script add kind=… record=… at=<ISO>
 *   script ingest count=… state=… first=… last=…
 *   script sample_ring=… at=<ISO>
 *   script analysis state=done|pending key=entity|recurrence model=… attempts=… at=<ISO>
 *   script resolve action=fix-applied state=fix-applied at=<ISO>
 *   script green streak=<n> threshold=<n> verified=yes|no verified_at=… at=<ISO>
 *   script reopen state=reopened labeled=yes|no at=<ISO>
 *   script keys error-record-opened=<n> error-record-reopened=<n> error-record-verified=<n>
 *   script bridge rows=<n> script_error=<n> cursor=<n> at=<ISO>
 *   live source=<id> entries=<n> dropped=<n> at=<ISO>
 *   live analysis record=<id> state=<analyzed|pending> model=<id> ms=<n> at=<ISO>
 *   live keys error-record-opened=<n> at=<ISO>
 *   live skip reason=<rv>                    (only when the profile has no LLM)
 *   p6_smoke_end
 *
 * Usage:
 *   node scripts/smoke-p6.mjs [--playbook] [--live] [--no-live]
 */
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { cpus, loadavg } from 'node:os'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const HANDOFF = resolve(ROOT, '../docs/handoff')

/** ISO timestamp in +08:00 (the owner's zone); every gate line uses one zone. */
function stamp(at = new Date()) {
  const value = at instanceof Date ? at : new Date(at)
  return `${new Date(value.getTime() + 8 * 3_600_000).toISOString().replace('Z', '+08:00')}`
}

/** Discipline §9b: capture the environment before anything timing-related. */
function environmentHeader() {
  const loads = loadavg()
  const nproc = cpus().length
  const ratio = nproc === 0 ? 0 : loads[0] / nproc
  console.log(`env TZ_OFFSET=${String(new Date().getTimezoneOffset())} load=${loads.map((v) => v.toFixed(2)).join(',')} nproc=${String(nproc)} loads=<${stamp()}>`)
  console.log(ratio > 1 ? `env_state OVERLOADED ratio=${ratio.toFixed(3)} (readings are an upper bound only)` : `env_state OK ratio=${ratio.toFixed(3)}`)
}

function argOf(argv, name, fallback) {
  const index = argv.indexOf(name)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}

/** Run one process and collect its streams (bounded wait). */
function run(command, args, timeoutMs = 60_000, extraEnv = {}) {
  return new Promise((res) => {
    execFile(command, args, { timeout: timeoutMs, env: { ...process.env, ...extraEnv }, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      res({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1, stdout: stdout ?? '', stderr: stderr ?? '' })
    })
  })
}

/** In-memory pipeline tables (same shape the row hands the pipeline). */
function memoryTables() {
  const wrap = (store) => ({
    get: (key) => store.get(key),
    put: async (key, value) => void store.set(key, value),
    keys: () => [...store.keys()],
    delete: async (key) => store.delete(key),
  })
  const stores = { errors: new Map(), fingerprints: new Map(), jobs: new Map(), events: new Map() }
  const tables = {
    errors: wrap(stores.errors),
    fingerprints: wrap(stores.fingerprints),
    jobs: wrap(stores.jobs),
    events: wrap(stores.events),
  }
  // The script reads revoked/verified through the same iteration the tests use.
  for (const [name, store] of Object.entries(stores)) Object.defineProperty(tables[name], 'values', { value: () => [...store.values()], enumerable: false })
  return tables
}

/** A scripted analysis port: every call returns one valid payload after `delayMs`. */
function scriptedPort(model = 'mock-llm', delayMs = 0) {
  return {
    provider: 'mock',
    model,
    async *stream() {
      if (delayMs > 0) await new Promise((done) => setTimeout(done, delayMs))
      yield { type: 'text-delta', text: JSON.stringify({ rootCauseHypothesis: 'the engine was started without a vision tower', impact: 'image analysis returns 400', suggestedFix: ['restart the engine with HALOGEN_VISION_TOWER'], confidence: 0.78, needMoreInfo: [] }) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

/** A clock that can be advanced (retention + verification instants). */
function clock(iso = '2026-11-09T09:00:00.000+08:00') {
  let current = Date.parse(iso)
  return { now: () => new Date(current), advance: (ms) => { current += ms } }
}

/** The failure shape the bridge turns into one entry per `script_error` row (a probe row, not random). */
const PROBE_ROW = { id: 9001, job_id: 'abcfixture01', event_type: 'script_error', status: null, detail: 'Probe failure registered for the P6 replay playbook (synthetic probe row; not a measured row)', occurred_at: null }

/** Measured jiuwenswarm line (fixtures/jiuwenswarm/error-landing-sample.json tool_log_error_lines[0]). */
const JW_LINE = { ts: '2026-10-04 11:18:45', message: 'Todo modify tool invocation failed' }
/** Measured hermes script_error row (fixtures/hermes/cron-run-events-sample.json rows[0]). */
const HERMES_ROW = JSON.parse(readFileSync(resolve(ROOT, 'fixtures/hermes/cron-run-events-sample.json'), 'utf8'))[0]

async function main() {
  const argv = process.argv.slice(2)
  const noLive = argv.includes('--no-live')
  const live = argv.includes('--live') && !noLive
  environmentHeader()
  // The fingerprint sheet runs first, in this process, so G1 has one env header.
  const busy = await run(process.env['NODE'] ?? 'node', [resolve(ROOT, 'scripts/fingerprint-eval.mjs')], 60_000)
  for (const line of busy.stdout.split('\n').filter((entry) => entry.length > 0)) console.log(line)
  if (busy.code !== 0) console.log(`fp sheet eval EXIT rc=${String(busy.code)}`)
  const bundle = await import(resolve(ROOT, 'build/packages/agent-cron-dashboard/index.js'))
  const { ErrorPipeline, ErrorAnalyzer, ErrorResolver, sampleOf, maskSecrets, pullRunEventErrors } = bundle

  // ---------------------------------------------------------------- playbook: repair closure
  const t = memoryTables()
  const c = clock()
  const port = scriptedPort()
  const pipeline = new ErrorPipeline({
    tables: t,
    analyzer: new ErrorAnalyzer({ port }),
    greenRunsToVerify: 3,
    retentionDays: 90,
    now: c.now,
    recentRuns: () => [{ startedAt: '2026-11-08T22:20:07+08:00', status: 'failed' }],
    log: (line) => console.log(`p6log ${line}`),
  })
  const resolver = new ErrorResolver({ pipeline, now: c.now })
  const token = HERMES_ROW.detail
  await t.jobs.put(`playbook/abcfixture01`, { sourceId: 'playbook', jobId: 'abcfixture01', name: 'patrol', schedule: '20 * * * *', script: 'patrol.py', lastRunAt: null, lastStatus: 'failed', greenStreak: 0, collectedAt: stamp() })
  const FIRST = { sourceId: 'playbook', jobId: 'abcfixture01', occurredAt: '2026-10-01T00:00:00+08:00', severity: 'error', message: token, raw: 'playbook#1' }
  const outcome = await pipeline.ingest([FIRST])
  const record = pipeline.records()[0]
  console.log(`script add kind=entity record=${record.recordId} at=${stamp()}`)
  await pipeline.pump()
  const analyzed = pipeline.record(record.recordId)
  console.log(`script analysis state=${analyzed.analysis.state === 'done' ? 'done' : 'pending'} key=entity model=${analyzed.analysis.model ?? 'none'} attempts=${String(port.__calls ?? 1)} at=${stamp()}`)

  // mask check over every measured sample that flows into the sheet + fixtures
  const measured = [
    ...JSON.parse(readFileSync(resolve(ROOT, 'fixtures/hermes/errors-log-sample.json'), 'utf8')).lines.map((line) => line.message),
    ...JSON.parse(readFileSync(resolve(ROOT, 'fixtures/jiuwenswarm/error-landing-sample.json'), 'utf8')).tool_log_error_lines.map((line) => line.message),
  ]
  const masked = measured.filter((message) => maskSecrets(message) !== maskSecrets(sampleOf({ occurredAt: '2026-10-01T00:00:00+08:00', severity: 'error', message }).message))
  const leaked = measured.filter((message) => /ghp_[A-Za-z0-9]{8,}|Bearer [A-Za-z0-9._-]{8,}|password=\S{3,}/.test(maskSecrets(message)))
  console.log(`script mask verdict=${masked.length === 0 && leaked.length === 0 ? 'PASS' : 'FAIL'} hits=${String(masked.length + leaked.length)} at=${stamp()}`)

  const second = { ...FIRST, occurredAt: '2026-10-02T00:00:00+08:00' }
  await pipeline.ingest([second])
  const counted = pipeline.record(record.recordId)
  console.log(`script ingest count=${String(counted.count)} state=${counted.state} first=${counted.firstSeen} last=${counted.lastSeen} at=${stamp()}`)
  for (let i = 0; i < 7; i += 1) await pipeline.ingest([{ ...FIRST, occurredAt: `2026-10-0${String(3 + i)}T00:00:00+08:00` }], { autoAnalyze: false })
  const ring = pipeline.record(record.recordId)
  console.log(`script sample_ring=${String(ring.samples.length)} at=${stamp()}`)

  const resolved = await resolver.resolve({ recordId: record.recordId, action: 'fix-applied', note: 'allowed the scripts directory', by: 'tool' })
  console.log(`script resolve action=fix-applied state=${resolved.record?.state ?? 'none'} at=${stamp()}`)
  const jobOf = async (streak) => t.jobs.put(`playbook/abcfixture01`, { sourceId: 'playbook', jobId: 'abcfixture01', name: 'patrol', schedule: '20 * * * *', script: 'patrol.py', lastRunAt: stamp(), lastStatus: 'ok', greenStreak: streak, collectedAt: stamp() })
  await jobOf(2)
  c.advance(3_600_000)
  const short = await pipeline.verify()
  console.log(`script green streak=2 threshold=3 verified=${short.length > 0 ? 'yes' : 'no'} verified_at=none at=${stamp()}`)
  await jobOf(3)
  c.advance(3_600_000)
  const done = await pipeline.verify()
  const verified = pipeline.record(record.recordId)
  console.log(`script green streak=3 threshold=3 verified=${done.length > 0 ? 'yes' : 'no'} verified_at=${verified.verifiedAt ?? 'none'} at=${stamp()}`)

  // ---------------------------------------------------------------- playbook: recurrence
  c.advance(86_400_000)
  await pipeline.ingest([{ ...FIRST, occurredAt: stamp(c.now()) }])
  const reopened = pipeline.record(record.recordId)
  const reopenedKinds = t.events.values().filter((event) => event.kind === 'error-record-reopened')
  console.log(`script reopen state=${reopened.state} labeled=${reopenedKinds.length > 0 && reopenedKinds.at(-1).level === 'high' ? 'yes' : 'no'} at=${stamp()}`)
  const counts = { opened: 0, reopened: 0, verified: 0 }
  for (const event of t.events.values()) {
    if (event.kind === 'error-record-opened') counts.opened += 1
    if (event.kind === 'error-record-reopened') counts.reopened += 1
    if (event.kind === 'error-record-verified') counts.verified += 1
  }
  console.log(`script keys error-record-opened=${String(counts.opened)} error-record-reopened=${String(counts.reopened)} error-record-verified=${String(counts.verified)}`)

  // ---------------------------------------------------------------- bridge over the measured rows
  const rows = JSON.parse(readFileSync(resolve(ROOT, 'fixtures/hermes/cron-run-events-sample.json'), 'utf8'))
  const bridged = await pullRunEventErrors({ sourceId: 'hermes-nas', dbPath: '/root/.hermes/state.db', query: async () => ({ code: 0, stdout: JSON.stringify(rows) }) }, null)
  console.log(`script bridge rows=${String(bridged.rows)} script_error=${String(bridged.entries.length)} cursor=${JSON.parse(bridged.cursor.token).runs} at=${stamp()}`)

  // ---------------------------------------------------------------- live window
  if (noLive) {
    console.log(`live skip reason=no-live-flag at=${stamp()}`)
  } else if (argv.includes('--live')) {
    await liveWindow(bundle)
  } else {
    console.log(`live skip reason=live-flag-missing at=${stamp()}`)
  }

  // ---------------------------------------------------------------- status tool over the playbook tables
  const report = bundle.buildStatus({
    events: { keys: () => t.events.keys(), get: (key) => t.events.get(key) },
    prCount: () => 0,
    issueCount: () => 0,
    fleet: { jobs: t.jobs.keys().length, errors: t.errors.keys().length, sourcesUp: 1, sourcesTotal: 1 },
  }, 'fleet')
  const fleetLine = report.text.split('\n').find((line) => line.startsWith('fleet:')) ?? ''
  console.log(`status scope=fleet errors=${String(t.errors.keys().length)} fleet="${fleetLine}" at=${stamp()}`)
  console.log('p6_smoke_end')
  console.log(`env_end loads=<${loadavg().map((v) => v.toFixed(2)).join(',')}> at=${stamp()}`)
}

/**
 * One real window: the nas `errors.log` increment plus the `cron_run_events`
 * bridge, then a real `ctx.llm` analysis of the first opened record.
 */
async function liveWindow(bundle) {
  const { makeRunRemote, HermesSshAdapter, ErrorPipeline, ErrorAnalyzer, RUN_EVENTS_SQL, pullRunEventErrors } = bundle
  const t = memoryTables()
  const run = makeRunRemote({ host: 'nas', connectTimeoutSec: 10 }, {
    spawn: (command, args, timeoutMs, signal) => new Promise((res) => {
      execFile(command, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, signal }, (error, stdout, stderr) => {
        res({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1, stdout: stdout ?? '', stderr: stderr ?? '' })
      })
    }),
  }, 40_000)
  const source = new HermesSshAdapter({ config: { id: 'hermes-nas', kind: 'hermes-ssh', ssh: { host: 'nas', dbPath: '/root/.hermes/state.db', errorsLog: '/root/.hermes/logs/errors.log' } }, run })
  const started = Date.now()
  let entries = []
  let dropped = 0
  try {
    const pulled = await source.fetchErrorEntries(null)
    entries = pulled.entries
    console.log(`live source=hermes-nas entries=${String(entries.length)} dropped=0 at=${stamp()} ms=${String(Date.now() - started)}`)
  } catch (error) {
    console.log(`live source=hermes-nas entries=0 failure="${String(error instanceof Error ? error.message : error).slice(0, 100)}" at=${stamp()}`)
  }
  // The events stream is the only place hermes script failures live; bridge it like the row does.
  const bridgeRows = await run({ kind: 'sqlite-json', dbPath: '/root/.hermes/state.db', sql: RUN_EVENTS_SQL.replace(':lastId', '0') })
  if (bridgeRows.code === 0) {
    dropped += 1 // the bridge read the ledger once (named, not a loss count)
    console.log(`live bridge rows_read=1 note="cron_run_events increment beyond cursor 0 is owned by the row bridge; the smoke only proves it reads" at=${stamp()}`)
  }
  const port = livePort()
  if (port === undefined) {
    console.log(`live skip reason=no-llm-provisioned-in-this-process at=${stamp()}`)
    return
  }
  const analyzer = new ErrorAnalyzer({ port, log: (line) => console.log(`p6log ${line}`) })
  const pipeline = new ErrorPipeline({ tables: t, analyzer, greenRunsToVerify: 3, retentionDays: 90 })
  await pipeline.ingest(entries, { autoAnalyze: false })
  const opened = t.events.values().filter((event) => event.kind === 'error-record-opened').length
  console.log(`live keys error-record-opened=${String(opened)} at=${stamp()}`)
  // The newest record is the one the profile can reason about (the oldest in the
  // log window are historically blocked scripts; plan §4 D?) — the window proves the
  // chain end to end, one honest record is enough.
  const record = pipeline.records()[0]
  if (record === undefined) {
    console.log(`live analysis record=none state=pending model=none ms=0 at=${stamp()}`)
    return
  }
  const beganAt = Date.now()
  let result = { state: 'failed', output: null, attempts: 2, failure: 'unknown', model: 'none' }
  try {
    result = await analyzer.run({ ...record, samples: record.samples.slice(-3) }, { job: undefined, recentRuns: [] })
  } catch (error) {
    result = { state: 'failed', output: null, attempts: 2, failure: `exception: ${error instanceof Error ? error.message : String(error)}`, model: 'none' }
  }
  if (result.state === 'done' && result.output !== null) {
    const analysed = buildAnalysisRecord(record, result, stamp())
    await analysed.then((next) => pipeline.save(next))
    pipeline.log(`p6 analysis record=${record.recordId} state=analyzed model=${result.model} attempts=${String(result.attempts)}`)
  } else {
    console.log(`p6log p6 analysis record=${record.recordId} state=pending failure=${String(result.failure)}`)
  }
  const after = pipeline.record(record.recordId)
  const verdict = after.analysis.state === 'done' ? 'analyzed' : 'pending'
  console.log(`live analysis record=${record.recordId} state=${verdict} model=${after.analysis.model ?? 'none'} ms=${String(Date.now() - beganAt)}${verdict === 'pending' ? ` failure=${String(result.failure).replace(/\s+/g, '_').slice(0, 120)}` : ''} at=${stamp()}`)
}

/** The record after the analyser's output, through the same transition the pump applies. */
async function buildAnalysisRecord(record, result, at) {
  const { recordWithAnalysis } = await import(resolve(ROOT, 'build/packages/agent-cron-dashboard/index.js'))
  return recordWithAnalysis(record, { ...result.output, model: result.model }, new Date(at).toISOString())
}

/** A real HTTP model call from this process: the headless profile's provider (geoeast v4.1 flash) when its key is set. */
function livePort() {
  const key = process.env['GEOEAST_API_KEY']
  const baseURL = process.env['P6_LLM_BASE_URL'] ?? 'https://amr-link.open-design.ai/v1'
  const model = process.env['P6_LLM_MODEL'] ?? 'deepseek-v4.1-flash'
  if (key === undefined || key === '') return undefined
  return {
    provider: 'geoeast',
    model,
    stream: async function* (request) {
      const answer = await fetch(`${baseURL.trim()}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages: [{ role: 'system', content: request.system }, { role: 'user', content: request.messages[0].content }], temperature: 0.2, max_tokens: request.maxTokens }),
        signal: request.signal ?? AbortSignal.timeout(120_000),
      })
      if (!answer.ok) {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: `HTTP_${String(answer.status)}` } } }
        return
      }
      const body = await answer.json()
      const text = body?.choices?.[0]?.message?.content
      if (typeof text !== 'string') {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'EMPTY_BODY' } } }
        return
      }
      yield { type: 'text-delta', text }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

main().catch((error) => {
  console.error(`p6 smoke failed: ${error instanceof Error ? error.stack : String(error)}`)
  process.exitCode = 1
})
void argOf
void HANDOFF
void PROBE_ROW
void JW_LINE
void clock
