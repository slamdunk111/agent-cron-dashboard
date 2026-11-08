/**
 * SSH executor with the P5 read-only whitelist (plan §2/§3.1).
 *
 * Every remote command the fleet adapters issue goes through {@link assertReadOnly}:
 * four shapes only — `sqlite3 -json 'file:...?mode=ro' '<select>'`, `tail -c <n> '<path>'`,
 * `wc -c '<path>'`, `stat -c '<fmt>' '<path>'`. Anything else throws before an ssh
 * process is spawned, so a configuration mistake can never turn into a remote write.
 */

/** Connection settings of one SSH target (mirrors `FleetSshConfig`). */
export interface SshTarget {
  /** ssh alias/host; rejected when it carries shell or option characters. */
  readonly host: string
  /** Extra `-o key=value` options; only the non-interactive allowlist is accepted. */
  readonly sshOptions?: readonly string[]
  /** ConnectTimeout seconds (default 10). */
  readonly connectTimeoutSec?: number
}

/** The four read-only shapes the adapters may issue. */
export type RemoteReadonly =
  | { readonly kind: 'sqlite-json'; readonly dbPath: string; readonly sql: string }
  | { readonly kind: 'tail-bytes'; readonly path: string; readonly bytes: number }
  | { readonly kind: 'wc-c'; readonly path: string }
  | { readonly kind: 'stat'; readonly format: string; readonly path: string }

/** Result of one remote read; a non-zero code is returned, never thrown. */
export interface RemoteResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** A remote executor (the adapters take it as a dependency so tests can replay fixtures). */
export type RunRemote = (read: RemoteReadonly, signal?: AbortSignal) => Promise<RemoteResult>

/** ssh `-o` keys the adapters may pass; everything else is refused. */
const SSH_OPTION_ALLOW = new Set(['BatchMode', 'ConnectTimeout', 'ServerAliveInterval', 'ServerAliveCountMax', 'Port', 'User', 'IdentityFile', 'StrictHostKeyChecking'])

/** Host/alias characters only: no shell metacharacters, no option prefix. */
const HOST_RE = /^[A-Za-z0-9_.@:-]+$/

/** Write verbs a SELECT may not start with (the schema already forbids a second statement). */
const SQL_WRITE_RE = /^\s*(?:PRAGMA|INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|ATTACH|DETACH|VACUUM)\b/i

/** Paths handed to tail/wc/stat; shell metacharacters are refused. */
const PATH_RE = /^\/[A-Za-z0-9_.\-/]*$/

/** `stat -c` format: a compact, quoting-free allowlist. */
const STAT_FORMAT_RE = /^%[dinNsY]?[^'"`$;|&<>\\]*$/

/** Single-quote one remote argument (`'` becomes `'\''`). */
function shQuote(text: string): string {
  return `'${text.replace(/'/g, "'\\''")}'`
}

/** Single-quote one argument without the path restriction (SQL bodies and formats). */
function sq(text: string): string {
  return shQuote(text)
}

/**
 * Build the remote command for one whitelisted read.
 * @param read - one of the four shapes.
 * @returns the exact string handed to ssh (also re-validated by {@link assertReadOnly}).
 */
export function buildRemoteCommand(read: RemoteReadonly): string {
  switch (read.kind) {
    case 'sqlite-json': {
      const uri = `file:${read.dbPath}?mode=ro`
      return `sqlite3 -json ${shQuote(uri)} ${sq(read.sql)}`
    }
    case 'tail-bytes':
      return `tail -c ${String(Math.trunc(read.bytes))} ${shQuote(read.path)}`
    case 'wc-c':
      return `wc -c ${shQuote(read.path)}`
    case 'stat':
      return `stat -c ${sq(read.format)} ${shQuote(read.path)}`
  }
}

/**
 * Refuse anything that is not one of the four whitelisted remote commands.
 * @param command - the full remote command string (as returned by {@link buildRemoteCommand}).
 * @throws Error carrying `refused` and the first rule that failed.
 */
export function assertReadOnly(command: string): void {
  const text = command.trim()
  const fail = (rule: string): never => {
    throw new Error(`ssh read-only whitelist refused (${rule}): ${text.slice(0, 120)}`)
  }
  // A second command needs an unquoted separator; quote-aware scan.
  let quoted = false
  for (const char of text) {
    if (char === "'") {
      quoted = !quoted
      continue
    }
    if (!quoted && (char === ';' || char === '|' || char === '&' || char === '>' || char === '<' || char === '`' || char === '$')) fail(`shell metacharacter ${char}`)
    if (!quoted && char === '\n') fail('newline')
  }
  if (quoted) fail('unbalanced quote')
  if (/^\s*sudo\b/.test(text)) fail('sudo')
  if (/\b(?:sh|bash|zsh)\s+-c\b/.test(text)) fail('shell wrapper')
  // Split like a shell would: whitespace outside quotes separates arguments. An
  // embedded quote cannot reach this point because every shQuote path character is
  // allowlisted by PATH_RE and SQL bodies are refused above.
  const args: string[] = []
  let current = ''
  let inQuote = false
  let hasCurrent = false
  for (const char of text) {
    if (char === "'") {
      inQuote = !inQuote
      hasCurrent = true
      continue
    }
    if (!inQuote && (char === ' ' || char === '\t')) {
      if (hasCurrent) {
        args.push(current)
        current = ''
        hasCurrent = false
      }
      continue
    }
    current += char
    hasCurrent = true
  }
  if (hasCurrent) args.push(current)
  const [program, ...rest] = args
  if (program === 'sqlite3') {
    const [flag, uri, sql, ...tailArgs] = rest
    if (flag !== '-json') fail('sqlite3 must use -json')
    if (uri === undefined || !uri.startsWith('file:')) fail('sqlite3 needs a file: URI')
    if (!uri.endsWith('?mode=ro')) fail('sqlite3 URI must end with ?mode=ro')
    if (sql === undefined) fail('sqlite3 needs one SELECT')
    if (tailArgs.length > 0) fail('sqlite3 takes one query only')
    if (COUNT_STATEMENTS(sql) !== 1) fail('sqlite3 query holds a second statement')
    if (SQL_WRITE_RE.test(sql)) fail('sqlite3 query is a write statement')
    if (!/^\s*select\b/i.test(sql)) fail('sqlite3 query must be a SELECT')
    return
  }
  if (program === 'tail') {
    const [flag, count, path, ...tailArgs] = rest
    if (flag !== '-c') fail('tail must use -c')
    if (count === undefined || !/^\d+$/.test(count)) fail('tail needs a byte count')
    if (path === undefined || !PATH_RE.test(path)) fail('tail path shape')
    if (tailArgs.length > 0) fail('tail takes one path only')
    return
  }
  if (program === 'wc') {
    const [flag, path, ...wcArgs] = rest
    if (flag !== '-c') fail('wc must use -c')
    if (path === undefined || !PATH_RE.test(path)) fail('wc path shape')
    if (wcArgs.length > 0) fail('wc takes one path only')
    return
  }
  if (program === 'stat') {
    const [flag, format, path, ...statArgs] = rest
    if (flag !== '-c') fail('stat must use -c')
    if (format === undefined || !STAT_FORMAT_RE.test(format)) fail('stat format shape')
    if (path === undefined || !PATH_RE.test(path)) fail('stat path shape')
    if (statArgs.length > 0) fail('stat takes one path only')
    return
  }
  return fail(`program ${String(program)} is not whitelisted`)
}

/** Count statements in a SQL body (a trailing semicolon and blanks are tolerated). */
function COUNT_STATEMENTS(sql: string): number {
  const body = sql.trim().replace(/[\s;]+$/, '')
  if (body === '') return 0
  const parts = body.split(/\s*;\s*/).filter((part) => part !== '')
  return parts.length
}

/**
 * Build the ssh argv for one target (BatchMode and ConnectTimeout are always set).
 * @param target - host plus optional allowlisted `-o` pairs.
 * @throws Error when the host or an option is outside the allowlist.
 */
export function sshArgs(target: SshTarget): string[] {
  if (!HOST_RE.test(target.host)) throw new Error(`ssh target host refused: ${target.host.slice(0, 40)}`)
  const args = ['-o', 'BatchMode=yes', '-o', `ConnectTimeout=${String(target.connectTimeoutSec ?? 10)}`]
  for (const option of target.sshOptions ?? []) {
    const index = option.indexOf('=')
    const key = index < 0 ? option : option.slice(0, index)
    if (!SSH_OPTION_ALLOW.has(key)) throw new Error(`ssh option is not on the allowlist: ${option.slice(0, 40)}`)
    if (!/^[A-Za-z0-9_.:=/,@-]+$/.test(option)) throw new Error(`ssh option value refused: ${option.slice(0, 40)}`)
    args.push('-o', option)
  }
  args.push(target.host)
  return args
}

/** The NAS tunnel echoes its closing line on stderr/stdout; the adapters drop it. */
const TUNNEL_NOISE_RE = /^Connection to .* closed\.?$/m

/** Remove the ProxyJump tunnel noise from a captured stream. */
export function stripTunnelNoise(text: string): string {
  return text
    .split('\n')
    .filter((line) => !TUNNEL_NOISE_RE.test(line.trim()))
    .join('\n')
}

/** What the executor needs from the environment (injected so tests replay without ssh). */
export interface RunRemoteDeps {
  /** Spawn one process; returns its exit code and raw streams. */
  readonly spawn: (command: string, args: readonly string[], timeoutMs: number, signal?: AbortSignal) => Promise<RemoteResult>
}

/**
 * Build a {@link RunRemote} bound to one target.
 * @param target - connection settings.
 * @param deps - process spawner (real ssh in production, a stub in tests).
 * @param timeoutMs - hard kill after this many milliseconds (default 30s).
 */
export function makeRunRemote(target: SshTarget, deps: RunRemoteDeps, timeoutMs = 30_000): RunRemote {
  return async (read, signal) => {
    const command = buildRemoteCommand(read)
    assertReadOnly(command)
    const result = await deps.spawn('ssh', [...sshArgs(target), command], timeoutMs, signal)
    return { code: result.code, stdout: stripTunnelNoise(result.stdout), stderr: stripTunnelNoise(result.stderr) }
  }
}
