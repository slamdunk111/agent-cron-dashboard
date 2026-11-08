import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { FleetSourceConfig } from '../contracts/fleet-source.ts'
import { JiuwenswarmLocalAdapter, jobOf, ledgerSql, parseJobs, runOf, statusOfRow, type JiuwenswarmRunRow, type LocalFiles } from '../packages/agent-cron-dashboard/src/fleet/jiuwenswarm-local.ts'
import type { LocalServiceProbe } from '../packages/agent-cron-dashboard/src/fleet/jiuwenswarm-local.ts'

/** Replay fixtures measured on this machine (probes/jiuwenswarm.md). */
const replay = JSON.parse(readFileSync(new URL('../fixtures/fleet/p5-replay.json', import.meta.url), 'utf8')) as {
  sources: {
    jiuwenswarm: {
      cron_jobs: { jobs: { id: string; name: string; enabled?: boolean; expired?: boolean; cron_expr?: string }[] }
      run_ledger: { rows: JiuwenswarmRunRow[] }
      error_landing: { tool_log_error_lines: { ts: string; module: string; level: string; message: string }[]; worker_logs_count: number }
    }
  }
}

const config: FleetSourceConfig = { id: 'jiuwen-gmk', kind: 'jiuwenswarm-local', paths: { state: '/tmp/jw-state' } }

/** Files stub: answers per path so the state directory never has to exist. */
function stubFiles(overrides: Partial<Record<'jobs' | 'ledger' | 'tool' | 'worker', { text?: string; size?: number; inode?: string }>> = {}) {
  const jobsText = overrides.jobs?.text ?? JSON.stringify(replay.sources.jiuwenswarm.cron_jobs)
  const ledgerText = overrides.ledger?.text ?? JSON.stringify(replay.sources.jiuwenswarm.run_ledger.rows)
  const calls: string[] = []
  const files: LocalFiles = {
    tail: async (path, bytes) => {
      calls.push(`tail:${path}:${String(bytes)}`)
      if (path.endsWith('cron_jobs.json')) return { code: 0, text: jobsText }
      if (path.endsWith('tool.log')) return { code: 0, text: overrides.tool?.text ?? '' }
      return { code: 0, text: overrides.worker?.text ?? '' }
    },
    stat: async (path) => {
      calls.push(`stat:${path}`)
      const inode = path.endsWith('tool.log') ? overrides.tool?.inode ?? '1.7' : overrides.worker?.inode ?? '1.8'
      const size = path.endsWith('tool.log') ? overrides.tool?.size ?? 0 : overrides.worker?.size ?? 0
      return { code: 0, text: `${inode} ${String(size)}\n` }
    },
    list: async (path) => {
      calls.push(`list:${path}`)
      return { code: 0, names: path.endsWith('worker-logs') ? ['runtime-worker-a.stderr.log', 'runtime-worker-b.stderr.log'] : [] }
    },
    sqlite: async (path, sql) => {
      calls.push(`sqlite:${sql}`)
      return { code: 0, text: path.endsWith('cron_run_ledger.db') ? ledgerText : '[]' }
    },
  }
  return { calls, files }
}

/** Service stub. */
function stubService(active: boolean): LocalServiceProbe {
  return { isActive: async () => ({ active, message: active ? null : 'unit is not active' }) }
}

function adapterOf(files: LocalFiles, active = true) {
  return new JiuwenswarmLocalAdapter({ config, files, service: stubService(active) })
}

describe('jiuwenswarm local adapter (replay of the measured samples)', () => {
  it('lists the measured task store, not cron_prompts', async () => {
    const { files } = stubFiles()
    const jobs = await adapterOf(files).listJobs()
    expect(jobs).toHaveLength(replay.sources.jiuwenswarm.cron_jobs.jobs.length)
    expect(jobs[0]?.schedule).toBe(replay.sources.jiuwenswarm.cron_jobs.jobs[0]?.cron_expr)
    expect(jobs[0]?.name).toBe(replay.sources.jiuwenswarm.cron_jobs.jobs[0]?.name)
  })

  it('annotates disabled and expired jobs in the display name', () => {
    const job = jobOf({ id: 'x', name: 'daily', enabled: false, expired: true, cron_expr: '0 0 9 * * ? *' }, 0)
    expect(job.name).toContain('disabled')
    expect(job.name).toContain('expired')
    expect(job.schedule).toBe('0 0 9 * * ? *')
    expect(job.script).toBeNull()
  })

  it('maps ledger rows to ok/running (no failure state was measured)', async () => {
    const { files } = stubFiles()
    const pulled = await adapterOf(files).fetchRuns(null)
    const rows = replay.sources.jiuwenswarm.run_ledger.rows
    expect(pulled.runs).toHaveLength(rows.length)
    expect(rows.every((row) => row.state === 'finished')).toBe(true)
    expect(pulled.runs.every((run) => run.status === 'ok')).toBe(true)
    // the cursor advances to the newest started_at of the rows pulled
    const newest = Math.max(...rows.map((row) => Number(row.started_at)))
    expect(pulled.cursor.token).toBe(JSON.stringify({ runs: newest }))
  })

  it('treats an unfinished run as running', () => {
    const row: JiuwenswarmRunRow = { run_id: 'r:1', job_id: 'j', state: 'running', started_at: 1, ended_at: null }
    expect(statusOfRow(row)).toBe('running')
    expect(runOf(row).finishedAt).toBeUndefined()
    expect(runOf({ ...row, state: 'finished', ended_at: 2 }).finishedAt).toBe('1970-01-01T00:00:02.000Z')
  })

  it('builds the incremental ledger query', () => {
    expect(ledgerSql(1794149400)).toBe('SELECT run_id,job_id,state,started_at,ended_at FROM cron_runs WHERE started_at > 1794149400 ORDER BY started_at')
  })

  it('scans worker-logs per file and keeps one offset per stderr file', async () => {
    const text = '2026-11-06 15:07:35 | tool | default_trace_id | ERROR | {"event_type":"tool_call_error","message":"Todo modify tool invocation failed"}\n'
    const { files } = stubFiles({ worker: { text, size: text.length } })
    const adapter = adapterOf(files)
    const first = await adapter.fetchErrorEntries(null)
    expect(first.entries.length).toBe(2) // one per worker file in the listing
    expect(first.entries[0]?.severity).toBe('error')
    const second = await adapter.fetchErrorEntries(first.cursor)
    expect(second.entries).toEqual([])
  })

  it('reads tool.log error lines in the pipe shape', async () => {
    const lines = replay.sources.jiuwenswarm.error_landing.tool_log_error_lines
    const text = `${lines.map((line) => `${line.ts} | ${line.module} | default_trace_id | ${line.level} | {"message":"${line.message}"}`).join('\n')}\n`
    const { files } = stubFiles({ tool: { text, size: text.length } })
    const pulled = await adapterOf(files).fetchErrorEntries(null)
    expect(pulled.entries.length).toBe(lines.length)
    expect(pulled.entries[0]?.message).toContain('Todo modify tool invocation failed')
  })

  it('reports up when the unit is active and down with a message when it is not', async () => {
    const { files } = stubFiles()
    expect((await adapterOf(files, true).health()).state).toBe('up')
    expect((await adapterOf(files, false).health()).state).toBe('down')
    expect((await adapterOf(files, false).health()).message).toContain('not active')
  })

  it('survives an unreadable tool.log (code 0 with no text, then a failing stat)', async () => {
    const files: LocalFiles = {
      tail: async () => ({ code: 1, text: '' }),
      stat: async () => ({ code: 1, text: '' }),
      list: async () => ({ code: 1, names: [] }),
      sqlite: async () => ({ code: 0, text: '[]' }),
    }
    const pulled = await adapterOf(files).fetchErrorEntries(null)
    expect(pulled.entries).toEqual([])
  })

  it('parses a bare-array job payload as well as jobs[]', () => {
    expect(parseJobs(JSON.stringify([{ id: 'a' }]))).toHaveLength(1)
    expect(parseJobs(JSON.stringify({ jobs: [{ id: 'b' }] }))).toHaveLength(1)
  })

  it('treats a corrupt cursor token as a first read instead of failing the poll', async () => {
    const { files } = stubFiles({ tool: { text: '2026-11-08 10:00:00,000 ERROR tools.x: boom\n', size: 48 } })
    const pulled = await adapterOf(files).fetchErrorEntries({ token: 'not-json' })
    expect(pulled.cursor.token).toContain('files')
  })

  it('does not read cron_prompts at all (probe §2)', async () => {
    const { files, calls } = stubFiles()
    await adapterOf(files).listJobs()
    expect(calls.some((call) => call.includes('cron_prompts'))).toBe(false)
  })
})
