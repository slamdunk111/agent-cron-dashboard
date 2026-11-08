import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { FleetSourceConfig } from '../contracts/fleet-source.ts'
import { HermesSshAdapter, parseJobsJson, parseJsonRows, runsFromRows, runsSql, type HermesRunRow } from '../packages/agent-cron-dashboard/src/fleet/hermes-ssh.ts'
import type { RemoteReadonly, RemoteResult } from '../packages/agent-cron-dashboard/src/fleet/ssh-exec.ts'

/** The replay fixture built from the measured NAS/jw samples (no network). */
const replay = JSON.parse(readFileSync(new URL('../fixtures/fleet/p5-replay.json', import.meta.url), 'utf8')) as {
  sources: {
    hermes: {
      jobs_json: { jobs: { id: string; name: string; schedule?: { display?: string }; script?: string; last_status?: string | null }[] }
      errors_log: { lines: { ts: string; level: string; logger: string; message: string }[] }
    }
  }
}

/** A config identical to the owner's NAS entry (design §7). */
const config: FleetSourceConfig = { id: 'hermes-nas', kind: 'hermes-ssh', ssh: { host: 'nas', dbPath: '/root/.hermes/state.db', errorsLog: '/root/.hermes/logs/errors.log' } }

const jobsText = JSON.stringify(replay.sources.hermes.jobs_json)

/** The measured event rows (40 rows: run + script_error pairs). */
function eventRows(): HermesRunRow[] {
  const rows: HermesRunRow[] = []
  let id = 3326
  // Two failed pairs, then two clean runs, each pair sharing the same instant.
  rows.push({ id: id++, job_id: '68f64ca3b0b1', event_type: 'run', status: null, detail: null, occurred_at: '2026-09-28T17:20:21+08:00' })
  rows.push({ id: id++, job_id: '68f64ca3b0b1', event_type: 'script_error', status: null, detail: 'Blocked: script path resolves outside the scripts directory', occurred_at: '2026-09-28T17:20:21+08:00' })
  rows.push({ id: id++, job_id: '68f64ca3b0b1', event_type: 'run', status: null, detail: null, occurred_at: '2026-09-28T16:20:20+08:00' })
  rows.push({ id: id++, job_id: '68f64ca3b0b1', event_type: 'script_error', status: null, detail: 'Blocked: same reason', occurred_at: '2026-09-28T16:20:20+08:00' })
  rows.push({ id: id++, job_id: '2d4f5e1bbf08', event_type: 'run', status: null, detail: null, occurred_at: '2026-09-28T17:22:00+08:00' })
  return rows
}

/** A remote stub: answers the four shapes from a scripted map and records the commands. */
function stubRemote(answers: { jobs?: string; stat?: string; wc?: string; tail?: string; sql?: string }) {
  const calls: string[] = []
  const run = async (read: RemoteReadonly): Promise<RemoteResult> => {
    calls.push(read.kind)
    const out =
      read.kind === 'stat' ? answers.stat ?? `${String(answers.jobs?.length ?? 0)}` :
      read.kind === 'wc-c' ? answers.wc ?? '0' :
      read.kind === 'tail-bytes' ? (read.path.endsWith('jobs.json') ? answers.jobs ?? jobsText : answers.tail ?? '') :
      answers.sql ?? '[]'
    return { code: 0, stdout: out.endsWith('\n') ? out : `${out}\n`, stderr: '' }
  }
  return { calls, run }
}

function adapterWith(answers: Parameters<typeof stubRemote>[0]) {
  const stub = stubRemote(answers)
  const adapter = new HermesSshAdapter({ config, run: stub.run })
  return { adapter, stub }
}

describe('hermes ssh adapter (replay of the measured NAS samples)', () => {
  it('lists every measured job definition through stat + tail of cron/jobs.json', async () => {
    const { adapter, stub } = adapterWith({ jobs: jobsText, stat: String(jobsText.length) })
    const jobs = await adapter.listJobs()
    expect(jobs.length).toBe(replay.sources.hermes.jobs_json.jobs.length)
    expect(stub.calls).toEqual(['stat', 'tail-bytes'])
    const first = jobs[0]!
    expect(first.name).toBe(replay.sources.hermes.jobs_json.jobs[0]!.name)
    expect(jobs.map((job) => job.lastStatus)).toContain('failed')
  })

  it('maps jobs.json last_status ok/error/null into the contract vocabulary', async () => {
    const { adapter } = adapterWith({ jobs: jobsText, stat: String(jobsText.length) })
    const jobs = await adapter.listJobs()
    for (const job of jobs) expect(['ok', 'failed', 'timeout', null]).toContain(job.lastStatus)
  })

  it('falls back to the job id when the definition was deleted from jobs.json (9 orphan job ids measured)', async () => {
    const { adapter } = adapterWith({ jobs: JSON.stringify({ jobs: [] }), stat: '12', sql: JSON.stringify(eventRows()) })
    const pulled = await adapter.fetchRuns(null)
    const runs = pulled.runs
    // the runs carry job ids that no definition covers; the adapter still reports them
    expect(runs.map((run) => run.jobId)).toEqual(expect.arrayContaining(['68f64ca3b0b1', '2d4f5e1bbf08']))
  })

  it('pairs run and script_error rows into one failed run (measured §4)', async () => {
    const rows = eventRows()
    const runs = runsFromRows(rows)
    expect(runs).toHaveLength(3)
    expect(runs.filter((run) => run.status === 'failed')).toHaveLength(2)
    expect(runs.find((run) => run.jobId === '2d4f5e1bbf08')?.status).toBe('ok')
  })

  it('issues the incremental query with the cursor id and advances to the max id', async () => {
    const rows = eventRows()
    const stub = stubRemote({ sql: JSON.stringify(rows) })
    const adapter = new HermesSshAdapter({ config, run: stub.run })
    const first = await adapter.fetchRuns(null)
    expect(first.cursor.token).toBe(JSON.stringify({ runs: 3330 }))
    // the server applies `id > lastId`; the stub replays that boundary exactly
    const empty = stubRemote({ sql: '[]' })
    const second = await new HermesSshAdapter({ config, run: empty.run }).fetchRuns(first.cursor)
    expect(second.runs).toEqual([])
    expect(second.cursor.token).toBe(first.cursor.token)
  })

  it('builds the read-only SQL from design §5.2', () => {
    expect(runsSql(7)).toBe('SELECT id,job_id,event_type,status,detail,occurred_at FROM cron_run_events WHERE id > 7 ORDER BY id')
  })

  it('returns error entries for ERROR and WARNING lines only, with redaction applied', async () => {
    const lines = replay.sources.hermes.errors_log.lines
    const text = lines.map((line) => `${line.ts} ${line.level} ${line.logger}: ${line.message}`).join('\n')
    const { adapter } = adapterWith({ stat: `1 2 ${String(text.length)}`, wc: `${String(text.length)}`, tail: text })
    const pulled = await adapter.fetchErrorEntries(null)
    expect(pulled.entries.length).toBeGreaterThan(0)
    for (const entry of pulled.entries) expect(['error', 'warning', 'critical']).toContain(entry.severity)
    expect(pulled.entries[0]?.raw).toContain('errors.log@')
  })

  it('keeps the log offset across ticks and reports a rotation when the inode changes', async () => {
    const text = '2026-11-08 23:00:00,000 ERROR tools.x: first failure\n'
    const stub = stubRemote({ stat: `1 2 ${String(text.length)}`, wc: `${String(text.length)}`, tail: text })
    const adapter = new HermesSshAdapter({ config, run: stub.run })
    const first = await adapter.fetchErrorEntries(null)
    const second = await adapter.fetchErrorEntries(first.cursor)
    expect(second.entries).toEqual([])
    // a second file version (new inode, different size) must reset the offset
    const rotated = stubRemote({ stat: `1 9 ${String(text.length)}`, wc: `${String(text.length)}`, tail: text })
    const again = new HermesSshAdapter({ config, run: rotated.run })
    const reread = await again.fetchErrorEntries(first.cursor)
    expect(reread.entries.length).toBe(1)
  })

  it('reports up with a latency when stat succeeds and down when it fails', async () => {
    const { adapter } = adapterWith({ stat: '1794151430' })
    const up = await adapter.health()
    expect(up.state).toBe('up')
    expect(up.latencyMs).toBeGreaterThanOrEqual(0)
    const down = new HermesSshAdapter({ config, run: async () => ({ code: 1, stdout: '', stderr: 'no route to host' }) })
    const health = await down.health()
    expect(health.state).toBe('down')
    expect(health.message).toContain('rc=1')
  })

  it('accepts a single JSON object row (not every sqlite build wraps rows in an array)', () => {
    expect(parseJsonRows<{ id: number }>('{"id":1}')).toEqual([{ id: 1 }])
  })

  it('merges two rows of the same job at the same instant into one group', async () => {
    const rows: HermesRunRow[] = [
      { id: 1, job_id: 'j', event_type: 'run', status: null, detail: null, occurred_at: '2026-11-08T10:00:00+08:00' },
      { id: 2, job_id: 'j', event_type: 'run', status: null, detail: null, occurred_at: '2026-11-08T10:00:00+08:00' },
    ]
    const runs = runsFromRows(rows)
    expect(runs).toHaveLength(1)
    expect(runs[0]?.status).toBe('ok')
  })

  it('parses both jobs.json shapes (object with jobs[] and a bare array)', () => {
    expect(parseJobsJson(JSON.stringify({ jobs: [{ id: 'a' }] }))).toHaveLength(1)
    expect(parseJobsJson(JSON.stringify([{ id: 'b' }]))).toHaveLength(1)
  })

  it('starts from offset zero when the persisted log cursor is corrupt', async () => {
    const text = '2026-11-08 23:00:00,000 ERROR tools.x: failure\n'
    const stub = stubRemote({ stat: `1 2 ${String(text.length)}`, wc: `${String(text.length)}`, tail: text })
    const adapter = new HermesSshAdapter({ config, run: stub.run })
    const reread = await adapter.fetchErrorEntries({ token: 'not-json' })
    expect(reread.entries).toHaveLength(1)
  })

  it('rejects a malformed cursor token without losing the poll', async () => {
    const stub = stubRemote({ sql: '[]' })
    const adapter = new HermesSshAdapter({ config, run: stub.run })
    const pulled = await adapter.fetchRuns({ token: 'not-json' })
    expect(pulled.runs).toEqual([])
    expect(pulled.cursor.token).toBe(JSON.stringify({ runs: 0 }))
  })
})
