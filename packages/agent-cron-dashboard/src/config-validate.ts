/**
 * Runtime validation of the frozen workbench config schema.
 *
 * GENERATED COPY: the source of truth is `contracts/config-validate.ts` in the
 * release repository; `pnpm sync:contracts` copies it into the package so the
 * published bundle is self-contained (dsh copies the linked package into the
 * profile node_modules, so relative hops above the package cannot resolve).
 */
/** Error raised when a config value violates the frozen schema. */
export class ConfigValidationError extends Error {
  /** Dotted path of the offending value, e.g. `$.identities[0].tokenEnv`. */
  readonly path: string
  /** Why the value was rejected. */
  readonly detail: string

  constructor(path: string, detail: string) {
    super(`${path}: ${detail}`)
    this.name = 'ConfigValidationError'
    this.path = path
    this.detail = detail
  }
}

const TOKEN_ENV_RE = /^[A-Z][A-Z0-9_]*$/
const REPO_URL_RE = /^(?:https?:\/\/)?(?:github\.com|gitcode\.com)\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?\/?$/
const SOURCE_ID_RE = /^[A-Za-z0-9_.-]+$/
const SSH_HOST_RE = /^[A-Za-z0-9_.:@][A-Za-z0-9_.@:-]*$/
/**
 * ssh options reach the adapter's command line, so only a fixed key allowlist
 * is accepted: an option such as `ProxyCommand=` would run an arbitrary
 * program. Same allowlist as the schema's `sshOptions.items.pattern`.
 */
const SSH_OPTION_RE = /^(?:ConnectTimeout|BatchMode|StrictHostKeyChecking|ServerAliveInterval|ServerAliveCountMax|IdentityFile|Port|User|KeepAliveInterval|ConnectRetries)=[A-Za-z0-9_.:=/,@-]+$/
const CRON_RE = /^([0-9*,/-]+ ){4}[0-9*,/-]+$/

const PLATFORMS = ['github', 'gitcode'] as const
const SOURCE_KINDS = ['hermes-ssh', 'jiuwenswarm-local', 'ssh-sqlite'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function intIn(path: string, value: unknown, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new ConfigValidationError(path, `expected integer in [${min}, ${max}]`)
  }
  return value
}

function boolAt(path: string, value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new ConfigValidationError(path, 'expected boolean')
  return value
}

function strAt(path: string, value: unknown, min: number, max: number): string {
  // Code-point length, matching JSON Schema `minLength`/`maxLength` (Ajv counts
  // code points, not UTF-16 units), so the two engines agree on emoji and
  // astral-plane input.
  const length = typeof value === 'string' ? Array.from(value).length : 0
  if (typeof value !== 'string' || length < min || length > max) {
    throw new ConfigValidationError(path, `expected string of length ${min}..${max}`)
  }
  return value
}

function rejectUnknownKeys(path: string, value: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new ConfigValidationError(`${path}.${key}`, 'unknown property (credentials and free-form fields are not accepted)')
  }
}

/**
 * Validate one `ssh-sqlite` query: a single read-only SELECT statement.
 *
 * This is the stricter companion of the schema's `readOnlyQuery` (`not:
 * ;\s*[^;\s]`, i.e. no second statement): a trailing semicolon is tolerated,
 * and a statement that does not start with SELECT (INSERT/UPDATE/DELETE/DROP/
 * PRAGMA/ATTACH ...) is refused before any adapter can run it.
 */
export function validateSshQuery(path: string, value: unknown): string {
  const query = strAt(path, value, 8, 4096)
  // Leading whitespace is allowed (schema `^\s*[Ss][Ee][Ll][Ee][Cc][Tt]\b`);
  // trailing semicolons and whitespace are tolerated.
  const trimmed = query.trim().replace(/[\s;]+$/, '')
  if (!/^select\b/i.test(trimmed)) throw new ConfigValidationError(path, 'expected a read-only SELECT statement')
  if (trimmed.includes(';')) throw new ConfigValidationError(path, 'expected a single statement (no second statement after SELECT)')
  return trimmed
}

/** Validate a tokenEnv field: it must be an environment variable NAME, never a credential literal. */
export function validateTokenEnv(path: string, value: unknown): string {
  const name = strAt(path, value, 3, 128)
  if (!TOKEN_ENV_RE.test(name)) throw new ConfigValidationError(path, 'expected an environment variable name (A-Z0-9_ only)')
  // A credential literal (ghp_..., glpat-..., sk-...) cannot pass the pattern
  // above, so the pattern is the single guard for both cases.
  return name
}

export interface IdentityConfig {
  platform: (typeof PLATFORMS)[number]
  username?: string
  tokenEnv?: string
}

export interface FleetSshConfigResolved {
  host: string
  dbPath?: string
  errorsLog?: string
  sshOptions?: string[]
}

export interface FleetSourceConfigResolved {
  id: string
  kind: (typeof SOURCE_KINDS)[number]
  label?: string
  enabled: boolean
  ssh?: FleetSshConfigResolved
  paths?: { state: string }
  query?: string
}

export interface WorkbenchConfig {
  identities: IdentityConfig[]
  watch: { repos: string[]; issuePollIntervalMs: number }
  fleet: FleetSourceConfigResolved[]
  poll: { fleetIntervalMs: number; backoffMaxMs: number }
  analysis: { llm: { enabled: boolean }; greenRunsToVerify: number; retentionDays: number }
  notify: { actionCards: boolean; digest: { enabled: boolean; cron: string } }
}

function validateIdentity(path: string, value: unknown): IdentityConfig {
  if (!isRecord(value)) throw new ConfigValidationError(path, 'expected object')
  rejectUnknownKeys(path, value, ['platform', 'username', 'tokenEnv'])
  if (!PLATFORMS.includes(value.platform as never)) throw new ConfigValidationError(`${path}.platform`, `expected one of ${PLATFORMS.join('|')}`)
  const identity: IdentityConfig = { platform: value.platform as IdentityConfig['platform'] }
  if (value.username !== undefined) identity.username = strAt(`${path}.username`, value.username, 1, 100)
  if (value.tokenEnv !== undefined) identity.tokenEnv = validateTokenEnv(`${path}.tokenEnv`, value.tokenEnv)
  if (identity.platform === 'gitcode' && identity.username === undefined) {
    throw new ConfigValidationError(`${path}.username`, 'required for gitcode identities')
  }
  return identity
}

function validateFleetSource(path: string, value: unknown): FleetSourceConfigResolved {
  if (!isRecord(value)) throw new ConfigValidationError(path, 'expected object')
  rejectUnknownKeys(path, value, ['id', 'kind', 'label', 'enabled', 'ssh', 'paths', 'query'])
  const id = strAt(`${path}.id`, value.id, 1, 64)
  if (!SOURCE_ID_RE.test(id)) throw new ConfigValidationError(`${path}.id`, 'expected [A-Za-z0-9_.-]+')
  if (!SOURCE_KINDS.includes(value.kind as never)) {
    throw new ConfigValidationError(`${path}.kind`, `expected one of ${SOURCE_KINDS.join('|')}`)
  }
  const source: FleetSourceConfigResolved = {
    id,
    kind: value.kind as FleetSourceConfigResolved['kind'],
    enabled: boolAt(`${path}.enabled`, value.enabled, true),
  }
  if (value.label !== undefined) source.label = strAt(`${path}.label`, value.label, 0, 100)
  if (value.ssh !== undefined) {
    if (!isRecord(value.ssh)) throw new ConfigValidationError(`${path}.ssh`, 'expected object')
    rejectUnknownKeys(`${path}.ssh`, value.ssh, ['host', 'dbPath', 'errorsLog', 'sshOptions'])
    const ssh: FleetSshConfigResolved = { host: strAt(`${path}.ssh.host`, value.ssh.host, 1, 253) }
    if (!SSH_HOST_RE.test(ssh.host)) throw new ConfigValidationError(`${path}.ssh.host`, 'expected ssh host/alias characters only')
    if (value.ssh.dbPath !== undefined) ssh.dbPath = strAt(`${path}.ssh.dbPath`, value.ssh.dbPath, 1, 4096)
    if (value.ssh.errorsLog !== undefined) ssh.errorsLog = strAt(`${path}.ssh.errorsLog`, value.ssh.errorsLog, 1, 4096)
    if (value.ssh.sshOptions !== undefined) {
      if (!Array.isArray(value.ssh.sshOptions) || value.ssh.sshOptions.length > 8) {
        throw new ConfigValidationError(`${path}.ssh.sshOptions`, 'expected array of at most 8 strings')
      }
      ssh.sshOptions = value.ssh.sshOptions.map((option, index) => {
        const text = strAt(`${path}.ssh.sshOptions[${index}]`, option, 1, 512)
        if (!SSH_OPTION_RE.test(text)) throw new ConfigValidationError(`${path}.ssh.sshOptions[${index}]`, 'ssh option is not on the allowlist (ConnectTimeout/BatchMode/StrictHostKeyChecking/...)')
        return text
      })
    }
    source.ssh = ssh
  }
  if (value.paths !== undefined) {
    if (!isRecord(value.paths)) throw new ConfigValidationError(`${path}.paths`, 'expected object')
    rejectUnknownKeys(`${path}.paths`, value.paths, ['state'])
    source.paths = { state: strAt(`${path}.paths.state`, value.paths.state, 1, 4096) }
  }
  if (value.query !== undefined) {
    source.query = validateSshQuery(`${path}.query`, value.query)
  }
  if (source.kind === 'hermes-ssh' || source.kind === 'ssh-sqlite') {
    if (source.ssh === undefined) throw new ConfigValidationError(`${path}.ssh`, `required for kind ${source.kind}`)
  }
  if (source.kind === 'jiuwenswarm-local' && source.paths === undefined) {
    throw new ConfigValidationError(`${path}.paths`, 'required for kind jiuwenswarm-local')
  }
  if (source.kind === 'ssh-sqlite' && source.query === undefined) {
    throw new ConfigValidationError(`${path}.query`, 'required for kind ssh-sqlite')
  }
  return source
}

/**
 * Validate a raw config value against the frozen schema and return it with
 * every default applied.
 * @param value - raw value (already JSON/YAML decoded).
 * @throws ConfigValidationError with a dotted path when the value is rejected.
 */
export function validateWorkbenchConfig(value: unknown): WorkbenchConfig {
  if (!isRecord(value)) throw new ConfigValidationError('$', 'expected object')
  rejectUnknownKeys('$', value, ['identities', 'watch', 'fleet', 'poll', 'analysis', 'notify'])

  const identities: IdentityConfig[] = []
  if (value.identities !== undefined) {
    if (!Array.isArray(value.identities)) throw new ConfigValidationError('$.identities', 'expected array')
    value.identities.forEach((entry, index) => identities.push(validateIdentity(`$.identities[${index}]`, entry)))
  }

  const rawWatch = value.watch
  if (rawWatch !== undefined && !isRecord(rawWatch)) throw new ConfigValidationError('$.watch', 'expected object')
  if (rawWatch !== undefined) rejectUnknownKeys('$.watch', rawWatch, ['repos', 'issuePollIntervalMs'])
  const repos: string[] = []
  if (rawWatch?.repos !== undefined) {
    if (!Array.isArray(rawWatch.repos)) throw new ConfigValidationError('$.watch.repos', 'expected array')
    rawWatch.repos.forEach((repo, index) => {
      const text = strAt(`$.watch.repos[${index}]`, repo, 1, 2048)
      if (!REPO_URL_RE.test(text)) throw new ConfigValidationError(`$.watch.repos[${index}]`, 'expected a github.com/gitcode.com repository URL')
      repos.push(text)
    })
  }

  const fleet: FleetSourceConfigResolved[] = []
  if (value.fleet !== undefined) {
    if (!Array.isArray(value.fleet)) throw new ConfigValidationError('$.fleet', 'expected array')
    value.fleet.forEach((entry, index) => fleet.push(validateFleetSource(`$.fleet[${index}]`, entry)))
  }

  const rawPoll = value.poll
  if (rawPoll !== undefined && !isRecord(rawPoll)) throw new ConfigValidationError('$.poll', 'expected object')
  if (rawPoll !== undefined) rejectUnknownKeys('$.poll', rawPoll, ['fleetIntervalMs', 'backoffMaxMs'])

  const rawAnalysis = value.analysis
  if (rawAnalysis !== undefined && !isRecord(rawAnalysis)) throw new ConfigValidationError('$.analysis', 'expected object')
  if (rawAnalysis !== undefined) rejectUnknownKeys('$.analysis', rawAnalysis, ['llm', 'greenRunsToVerify', 'retentionDays'])
  const rawLlm = rawAnalysis?.llm
  if (rawLlm !== undefined && !isRecord(rawLlm)) throw new ConfigValidationError('$.analysis.llm', 'expected object')
  if (rawLlm !== undefined) rejectUnknownKeys('$.analysis.llm', rawLlm, ['enabled'])

  const rawNotify = value.notify
  if (rawNotify !== undefined && !isRecord(rawNotify)) throw new ConfigValidationError('$.notify', 'expected object')
  if (rawNotify !== undefined) rejectUnknownKeys('$.notify', rawNotify, ['actionCards', 'digest'])
  const rawDigest = rawNotify?.digest
  if (rawDigest !== undefined && !isRecord(rawDigest)) throw new ConfigValidationError('$.notify.digest', 'expected object')
  if (rawDigest !== undefined) rejectUnknownKeys('$.notify.digest', rawDigest, ['enabled', 'cron'])

  const cron = rawDigest?.cron === undefined ? '0 9 * * *' : strAt('$.notify.digest.cron', rawDigest.cron, 9, 64)
  if (!CRON_RE.test(cron)) throw new ConfigValidationError('$.notify.digest.cron', 'expected a 5-field cron expression')

  return {
    identities,
    watch: {
      repos,
      issuePollIntervalMs: intIn('$.watch.issuePollIntervalMs', rawWatch?.issuePollIntervalMs, 60000, 86400000, 300000),
    },
    fleet,
    poll: {
      fleetIntervalMs: intIn('$.poll.fleetIntervalMs', rawPoll?.fleetIntervalMs, 60000, 86400000, 300000),
      backoffMaxMs: intIn('$.poll.backoffMaxMs', rawPoll?.backoffMaxMs, 600000, 86400000, 3600000),
    },
    analysis: {
      llm: { enabled: boolAt('$.analysis.llm.enabled', rawLlm?.enabled, true) },
      greenRunsToVerify: intIn('$.analysis.greenRunsToVerify', rawAnalysis?.greenRunsToVerify, 1, 20, 3),
      retentionDays: intIn('$.analysis.retentionDays', rawAnalysis?.retentionDays, 7, 3650, 90),
    },
    notify: {
      actionCards: boolAt('$.notify.actionCards', rawNotify?.actionCards, true),
      digest: { enabled: boolAt('$.notify.digest.enabled', rawDigest?.enabled, true), cron },
    },
  }
}
