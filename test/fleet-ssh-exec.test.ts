import { describe, expect, it } from 'vitest'
import { assertReadOnly, buildRemoteCommand, makeRunRemote, sshArgs, stripTunnelNoise, type RemoteReadonly } from '../packages/agent-cron-dashboard/src/fleet/ssh-exec.ts'

/** The four whitelisted shapes, each built once so positive and negative tests share the same surface. */
const sqlRead: RemoteReadonly = { kind: 'sqlite-json', dbPath: '/root/.hermes/state.db', sql: 'SELECT id, job_id FROM cron_run_events WHERE id > 0 ORDER BY id' }
const tailRead: RemoteReadonly = { kind: 'tail-bytes', path: '/root/.hermes/logs/errors.log', bytes: 262144 }
const wcRead: RemoteReadonly = { kind: 'wc-c', path: '/root/.hermes/cron/jobs.json' }
const statRead: RemoteReadonly = { kind: 'stat', format: '%d %i %s', path: '/root/.hermes/logs/errors.log' }

describe('ssh executor (P5 whitelist)', () => {
  it('runs a whitelisted read through the spawned ssh and strips the tunnel line', async () => {
    const calls: string[] = []
    const run = makeRunRemote({ host: 'nas' }, {
      spawn: async (command, args) => {
        calls.push(`${command} ${args.join(' ')}`)
        return { code: 0, stdout: '[{"id":3365}]\nConnection to 127.0.0.1 closed.\n', stderr: 'Connection to 127.0.0.1 closed.\n' }
      },
    })
    const result = await run(sqlRead)
    expect(calls[0]).toContain('ssh -o BatchMode=yes -o ConnectTimeout=10 nas')
    expect(calls[0]).toContain("sqlite3 -json 'file:/root/.hermes/state.db?mode=ro'")
    expect(result.stdout).toBe('[{"id":3365}]\n')
    expect(result.stderr).toBe('')
    expect(result.code).toBe(0)
  })

  it('returns the exit code instead of throwing when the remote read fails', async () => {
    const run = makeRunRemote({ host: 'nas' }, { spawn: async () => ({ code: 255, stdout: '', stderr: 'no route' }) })
    const result = await run(statRead)
    expect(result.code).toBe(255)
    expect(result.stderr).toBe('no route')
  })

  it('keeps a plain multi-line stream untouched when it has no tunnel noise', () => {
    expect(stripTunnelNoise('a\nb\n')).toBe('a\nb\n')
    expect(stripTunnelNoise('')).toBe('')
  })

  it('refuses to spawn when the built command would not pass the whitelist', async () => {
    const calls: string[] = []
    const run = makeRunRemote({ host: 'nas' }, { spawn: async () => { calls.push('spawned'); return { code: 0, stdout: '', stderr: '' } } })
    await expect(run({ kind: 'sqlite-json', dbPath: '/root/.hermes/state.db', sql: 'SELECT 1; DELETE FROM t' })).rejects.toThrow(/refused/)
    expect(calls).toEqual([])
  })

  it('builds the sqlite JSON shape with a read-only URI', () => {
    expect(buildRemoteCommand(sqlRead)).toBe(
      "sqlite3 -json 'file:/root/.hermes/state.db?mode=ro' 'SELECT id, job_id FROM cron_run_events WHERE id > 0 ORDER BY id'",
    )
  })

  it('builds the tail / wc / stat shapes', () => {
    expect(buildRemoteCommand(tailRead)).toBe("tail -c 262144 '/root/.hermes/logs/errors.log'")
    expect(buildRemoteCommand(wcRead)).toBe("wc -c '/root/.hermes/cron/jobs.json'")
    expect(buildRemoteCommand(statRead)).toBe("stat -c '%d %i %s' '/root/.hermes/logs/errors.log'")
  })

  it('escapes a single quote inside a remote path so the tunnel keeps one argument', () => {
    const read: RemoteReadonly = { kind: 'tail-bytes', path: "/root/.hermes/it's.log", bytes: 10 }
    expect(buildRemoteCommand(read)).toBe("tail -c 10 '/root/.hermes/it'\\''s.log'")
  })

  it('accepts every whitelisted shape through assertReadOnly', () => {
    for (const read of [sqlRead, tailRead, wcRead, statRead]) {
      expect(() => assertReadOnly(buildRemoteCommand(read))).not.toThrow()
    }
  })

  it('accepts the non-interactive ssh option allowlist and rejects the rest', () => {
    expect(sshArgs({ host: 'nas', connectTimeoutSec: 10 })).toEqual(['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'nas'])
    expect(sshArgs({ host: 'nas', sshOptions: ['Port=22', 'User=root'] })).toEqual(['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'Port=22', '-o', 'User=root', 'nas'])
    expect(() => sshArgs({ host: 'nas', sshOptions: ['ProxyCommand=evil'] })).toThrow(/allowlist/)
    expect(() => sshArgs({ host: 'nas; rm -rf /' })).toThrow(/host/)
  })

  it.each([
    ['recursive delete', 'rm -r -f /tmp/x'],
    ['privilege escalation', 'sudo sqlite3 file:/root/.hermes/state.db?mode=ro SELECT 1'],
    ['shell wrapper', "sh -c 'cat /root/.hermes/logs/errors.log'"],
    ['copy', 'cp /root/.hermes/state.db /tmp/x.db'],
    ['move', 'mv /root/.hermes/logs/errors.log /tmp/'],
    ['permission change', 'chmod 777 /root/.hermes/state.db'],
    ['redirect write', 'echo x > /root/.hermes/logs/errors.log'],
    ['sqlite without mode=ro', "sqlite3 /root/.hermes/state.db 'SELECT 1'"],
    ['sqlite with mode=rw', "sqlite3 -json 'file:/root/.hermes/state.db?mode=rw' 'SELECT 1'"],
    ['sql with a second statement', "sqlite3 -json 'file:/root/.hermes/state.db?mode=ro' 'SELECT 1; DROP TABLE t'"],
    ['sql that writes', "sqlite3 -json 'file:/root/.hermes/state.db?mode=ro' 'INSERT INTO t VALUES (1)'"],
    ['chained second command', "stat -c '%s' /root/.hermes/logs/errors.log; rm -r -f /tmp/x"],
  ])('refuses %s', (_label, command) => {
    expect(() => assertReadOnly(command)).toThrow(/refused/)
  })
})
