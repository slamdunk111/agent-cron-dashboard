import { describe, expect, it } from 'vitest'
import type { FleetSourceConfig } from '../contracts/fleet-source.ts'
import { GenericSshSqliteAdapter, boundarySql, errorOfRow, jobOfRow, parseRows, runOfRow, type GenericSourceConfig } from '../packages/agent-cron-dashboard/src/fleet/generic-ssh-sqlite.ts'
import type { RemoteReadonly, RemoteResult } from '../packages/agent-cron-dashboard/src/fleet/ssh-exec.ts'

const config: GenericSourceConfig = {
  id: 'any-ssh',
  kind: 'ssh-sqlite',
  ssh: { host: 'example', dbPath: '/srv/app.db' },
  query: 'SELECT * FROM jobs',
  runsQuery: 'SELECT id, job_id, started_at, status FROM runs WHERE id > :lastId',
  jobsQuery: 'SELECT job_id, name, schedule, script, last_run_at, last_status FROM jobs',
  errorsQuery: 'SELECT occurred_at, severity, message FROM errors',
}

/** Remote stub keyed on the SQL text. */
function stub(sqlRows: Record<string, Record<string, unknown>[]> | string) {
  const calls: string[] = []
  const run = async (read: RemoteReadonly): Promise<RemoteResult> => {
    calls.push(read.kind === 'stat' ? 'stat' : read.kind === 'sqlite-json' ? (read as { sql: string }).sql : read.kind)
    const text = typeof sqlRows === 'string' ? sqlRows : JSON.stringify(Object.entries(sqlRows).find(([marker]) => (read as { sql?: string }).sql?.includes(marker))?.[1] ?? [])
    return { code: 0, stdout: text, stderr: '' }
  }
  return { calls, run }
}

function adapterWith(rows: Record<string, Record<string, unknown>[]> | string) {
  const s = stub(rows)
  const adapter = new GenericSshSqliteAdapter({ config, run: s.run })
  return { adapter, stub: s }
}

describe('generic ssh-sqlite adapter', () => {
  it('maps the configured runs query into contract runs', async () => {
    const { adapter } = adapterWith({ runs: [{ id: 3, job_id: 'j1', started_at: '2026-11-08T10:00:00+08:00', status: 'ok' }, { id: 4, job_id: 'j2', started_at: '2026-11-08T11:00:00+08:00', status: 'failed' }] })
    const pulled = await adapter.fetchRuns(null)
    expect(pulled.runs.map((run) => run.status)).toEqual(['ok', 'failed'])
    expect(pulled.cursor.token).toBe('4')
  })

  it('applies the id boundary of the query with the persisted cursor', async () => {
    const { adapter, stub: s } = adapterWith({ runs: [] })
    await adapter.fetchRuns({ token: '41' })
    expect(s.calls[0]).toContain('WHERE id > 41')
  })

  it('maps jobs with the configured columns', async () => {
    const { adapter } = adapterWith({ jobs: [{ job_id: 'j1', name: 'nightly', schedule: '0 3 * * *', script: 'run.py', last_run_at: '2026-11-08T03:00:00+08:00', last_status: 'ok' }] })
    const jobs = await adapter.listJobs()
    expect(jobs).toEqual([{ id: 'j1', name: 'nightly', schedule: '0 3 * * *', script: 'run.py', lastRunAt: '2026-11-08T03:00:00+08:00', lastStatus: 'ok' }])
  })

  it('names the columns a row lacks instead of throwing', async () => {
    const { adapter } = adapterWith({ runs: [{ id: 1, started_at: 'x', status: 'ok' }] })
    const pulled = await adapter.fetchRuns(null)
    expect(pulled.runs).toEqual([])
    expect(adapter.notes.runs).toContain('missing column job_id')
  })

  it('maps error rows with their severity and redaction', async () => {
    const { adapter } = adapterWith({ errors: [{ occurred_at: '2026-11-08T10:00:00+08:00', severity: 'WARN', message: 'disk almost full' }] })
    const pulled = await adapter.fetchErrorEntries(null)
    expect(pulled.entries[0]).toMatchObject({ sourceId: 'any-ssh', severity: 'warning', message: 'disk almost full' })
  })

  it('reports down when the database cannot be stat-ed and up otherwise', async () => {
    const { adapter } = adapterWith({})
    expect((await adapter.health()).state).toBe('up')
    const down = new GenericSshSqliteAdapter({ config, run: async () => ({ code: 255, stdout: '', stderr: 'connection refused' }) })
    const health = await down.health()
    expect(health.state).toBe('down')
    expect(health.message).toBe('stat failed rc=255')
  })

  it('fails loudly when the config lacks the required query or ssh block', () => {
    expect(() => new GenericSshSqliteAdapter({ config: { ...config, query: undefined }, run: async () => ({ code: 0, stdout: '', stderr: '' }) })).toThrow(/no query/)
    expect(() => new GenericSshSqliteAdapter({ config: { ...config, ssh: undefined }, run: async () => ({ code: 0, stdout: '', stderr: '' }) })).toThrow(/no ssh/)
  })

  it('substitutes the :lastId placeholder only with an integer', () => {
    expect(boundarySql('SELECT id FROM t WHERE id > :lastId', 9)).toBe('SELECT id FROM t WHERE id > 9')
    expect(boundarySql('SELECT id FROM t', 9)).toBe('SELECT id FROM t')
  })

  it('parses empty and single-row payloads', () => {
    expect(parseRows('')).toEqual([])
    expect(parseRows('{"a":1}')).toEqual([{ a: 1 }])
  })

  it('maps a partial job row and a bad status word defensively', () => {
    const notes: string[] = []
    expect(jobOfRow({ job_id: 'j1' }, notes)).toMatchObject({ id: 'j1', name: 'j1', schedule: null })
    expect(jobOfRow({}, notes)).toBeUndefined()
    expect(notes).toContain('missing column job_id')
  })

  it('maps a run row with a non-standard status word to running', () => {
    const notes: string[] = []
    expect(runOfRow({ id: 1, job_id: 'j', started_at: 'x', status: 'weird' }, notes)?.status).toBe('running')
  })

  it('maps questionable severity words to error unless they are clearly informational', () => {
    const notes: string[] = []
    expect(errorOfRow({ occurred_at: 'x', severity: 'INFO', message: 'note' }, 'src', [], notes)?.severity).toBe('info')
    expect(errorOfRow({ occurred_at: 'x', severity: 'boom', message: 'note' }, 'src', [], notes)?.severity).toBe('error')
  })

  it('maps an error row without the required columns to undefined', () => {
    const notes: string[] = []
    expect(errorOfRow({ severity: 'error' }, 'src', [], notes)).toBeUndefined()
    expect(notes).toContain('missing column occurred_at')
  })
})
