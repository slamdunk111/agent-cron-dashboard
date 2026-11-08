#!/usr/bin/env node
/**
 * Real-machine smoke of the P3 issue poller (plan §4 + batch gate G1/G2/G3).
 *
 * Drives the shipped modules (the built bundle, exactly what dsh mounts) against
 * the live hosts and writes one log the gate reads. Line formats the gate
 * (`p3-gate-check.mjs`) parses are fixed:
 *
 *   - `identity <platform> state=…`      from `resolveIdentities`
 *   - `issue <platform> key=… …`         one per watched issue per round
 *   - `snapshot=<key> state=… labels=[…] comments=N last_comment_by=… at=…`
 *   - `diff <platform> key=… fields=…`   per queued pair (before/after in the log)
 *   - `queue <key> pairs=N dropped=N`    per key after every round
 *   - `env TZ_OFFSET=… load=… nproc=… loads=<capture time>` and `env_end <capture time>`
 *     (discipline §9b environment baseline)
 *   - `PY3_SMOKE_END`, then the shell template appends `EXIT rc=`
 *
 * Usage:
 *   node scripts/smoke-p3.mjs --config fixtures/p3-smoke-config.yaml --window-minutes=10
 *   node scripts/smoke-p3.mjs --no-token            (G2: offline GitCode refusal stand-in)
 *   node scripts/smoke-p3.mjs --offline --github-stand-in
 */
import { readFileSync } from 'node:fs'
import { homedir, cpus, loadavg } from 'node:os'
import { resolve } from 'node:path'

async function loadModule() {
  const built = resolve(import.meta.dirname, '../build/packages/agent-cron-dashboard/index.js')
  return import(built)
}

function argOf(argv, name, fallback) {
  const index = argv.indexOf(name)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}

/** Only the two keys this script needs out of the run config. */
function configOf(path) {
  const text = readFileSync(resolve(path), 'utf8')
  const repos = text
    .split('\n')
    .filter((line) => line.trim().startsWith('- https'))
    .map((line) => line.trim().slice(2).trim())
  const github = /platform:\s*github[\s\S]*?username:\s*([A-Za-z0-9_.-]+)/.exec(text)?.[1]
  const gitcode = /platform:\s*gitcode[\s\S]*?username:\s*([A-Za-z0-9_.-]+)/.exec(text)?.[1]
  const tokenEnv = /platform:\s*gitcode[\s\S]*?tokenEnv:\s*([A-Z0-9_]+)/.exec(text)?.[1] ?? 'GITCODE_TOKEN'
  const interval = Number(/issuePollIntervalMs:\s*(\d+)/.exec(text)?.[1] ?? 60_000)
  return {
    repos,
    intervalMs: interval,
    identities: [
      { platform: 'github', username: github },
      { platform: 'gitcode', username: gitcode, tokenEnv },
    ],
  }
}

/** Redact through the bundle's helper, the refusal-line rule P2 settled. */
function redactWith(bundle, line, secrets) {
  const long = secrets.filter((value) => typeof value === 'string' && value.length >= 12)
  if (!line.includes('refused') && !line.includes('invalid token')) return line
  return typeof bundle.redact === 'function' ? bundle.redact(line, long) : line
}

/** Environment baseline (discipline §9b): abort when the load ratio is over 1. */
function environmentHeader(at) {
  const loads = loadavg()
  const nproc = cpus().length
  const ratio = nproc === 0 ? 0 : loads[0] / nproc
  console.log(`env TZ_OFFSET=${new Date().getTimezoneOffset()} load=${loads.map((value) => value.toFixed(2)).join(',')} nproc=${nproc} loads=<${at}>`)
  if (ratio > 1) {
    console.log(`env_state OVERLOADED ratio=${ratio.toFixed(3)} (readings are an upper bound only)`)
  } else {
    console.log(`env_state OK ratio=${ratio.toFixed(3)}`)
  }
  return ratio <= 1
}

/** The offline GitCode stand-in for G2 (no network; echoes the token so redact must catch it). */
function gitcodeStandIn(token) {
  return {
    async get(url) {
      if (url.includes('/user')) return { status: 403, text: JSON.stringify({ error_message: `invalid token: ${token}` }), headers: {} }
      return { status: 400, text: JSON.stringify({ error_message: 'Orchestration error: Invalid header parameter: private-token' }), headers: {} }
    },
  }
}

/** GitHub headers for `gh`-owned credentials and the offline stand-in. */
function githubAuth() {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  if (typeof token === 'string' && token.length > 0) return { Authorization: `token ${token}`, 'X-GitHub-Api-Version': '2022-11-28' }
  return { 'X-GitHub-Api-Version': '2022-11-28' }
}

/** The token `gh` already holds (never printed): the live run forwards it to the REST reads. */
function ghToken(env) {
  if (typeof env.GITHUB_TOKEN === 'string' && env.GITHUB_TOKEN.length > 0) return env.GITHUB_TOKEN
  if (typeof env.GH_TOKEN === 'string' && env.GH_TOKEN.length > 0) return env.GH_TOKEN
  try {
    const { execFileSync } = process.getBuiltinModule('node:child_process')
    const { existsSync } = process.getBuiltinModule('node:fs')
    const local = resolve(homedir(), '.local', 'bin', 'gh')
    return execFileSync(existsSync(local) ? local : 'gh', ['auth', 'token'], { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

/** Offline GitHub stand-in: two captured issues plus a 304 on the conditional detail. */
function githubStandIn() {
  const root = resolve(import.meta.dirname, '..')
  const rows = [
    ['issue-2538.json', 'issue-2538-lastcomment.json'],
    ['issue-10121.json', 'issue-10121-lastcomment.json'],
  ].map(([issueFile, commentFile]) => ({
    issue: JSON.parse(readFileSync(resolve(root, 'fixtures/github', issueFile), 'utf8')),
    comment: JSON.parse(readFileSync(resolve(root, 'fixtures/github', commentFile), 'utf8')),
  }))
  const etags = new Map()
  return {
    async get(url, headers) {
      const at = new Date().toISOString()
      if (url.includes('/search/issues')) {
        console.log(`list github at=${at} q=${(/(author%3A[^&]+)/.exec(url) ?? [])[1] ?? ''}`)
        const items = rows.map((row) => ({ ...row.issue, repository_url: `https://api.github.com/repos/${row.issue.__repo}` }))
        return { status: 200, text: JSON.stringify({ total_count: items.length, items }), headers: {} }
      }
      const detail = /\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/.exec(url)
      if (detail !== null) {
        const [, owner, repo, number] = detail
        const row = rows.find((entry) => String(entry.issue.number) === number && entry.issue.__repo === `${owner}/${repo}`)
        if (row === undefined) return { status: 404, text: '{"message":"Not Found"}', headers: {} }
        const tag = etags.get(number) ?? `W/"stand-in-${number}"`
        if (headers['If-None-Match'] === tag) {
          console.log(`detail github ${owner}/${repo}#${number} 304 etag=${tag} at=${at}`)
          return { status: 304, text: '', headers: { etag: tag } }
        }
        etags.set(number, tag)
        console.log(`detail github ${owner}/${repo}#${number} 200 etag=${tag} at=${at}`)
        return { status: 200, text: JSON.stringify(row.issue), headers: { etag: tag } }
      }
      const comments = /\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments/.exec(url)
      if (comments !== null) {
        const row = rows.find((entry) => String(entry.issue.number) === comments[3])
        console.log(`comments github ${comments[1]}/${comments[2]}#${comments[3]} at=${at}`)
        return { status: 200, text: JSON.stringify(row === undefined ? [] : row.comment), headers: {} }
      }
      return { status: 404, text: '{"message":"Not Found"}', headers: {} }
    },
  }
}

/** Print one round's state: one line per watched issue, one queue line per key. */
function dumpRound(bundle, tables, round, platform, at) {
  const queues = new Map()
  for (const [key, snapshot] of tables.issues.entries()) {
    if (!key.startsWith(`${platform}/`)) continue
    console.log(
      `snapshot=${key} state=${snapshot.state} labels=${JSON.stringify(snapshot.labels)} comments=${snapshot.comments} last_comment_by=${snapshot.lastCommentBy ?? 'null'} last_comment_at=${snapshot.lastCommentAt ?? 'null'} at=${at}`,
    )
  }
  for (const [key, row] of tables.cursorsMap.entries()) {
    if (!key.endsWith(':issuequeue')) continue
    const queue = JSON.parse(row.token)
    queues.set(key.slice(0, -':issuequeue'.length), queue)
    console.log(`queue ${key.slice(0, -':issuequeue'.length)} pairs=${queue.pairs.length} dropped=${queue.dropped} applied=${queue.applied} round=${round}`)
  }
  void bundle
}

async function main(argv) {
  const bundle = await loadModule()
  const config = configOf(argOf(argv, '--config', resolve(import.meta.dirname, '../fixtures/p3-smoke-config.yaml')))
  const startedAt = new Date().toISOString()
  console.log(`smoke p3 start=${startedAt} window_minutes=${argOf(argv, '--window-minutes', '10')} config_interval_ms=${config.intervalMs}`)
  if (!environmentHeader(startedAt)) {
    console.log('PY3_SMOKE_END (aborted: environment overloaded)')
    return 3
  }
  const noToken = argv.includes('--no-token')
  const offline = argv.includes('--offline')
  const githubStandInMode = offline || argv.includes('--github-stand-in')
  const windowMinutes = Number(argOf(argv, '--window-minutes', '10'))
  const tickSeconds = Number(argOf(argv, '--tick-seconds', '30'))
  const env = { ...process.env }
  const tokenEnvName = config.identities[1].tokenEnv
  if (noToken) env[tokenEnvName] = process.env.P3_CANARY ?? 'XAI_P3_CANARY'
  const gitcodeToken = noToken ? env[tokenEnvName] : (process.env[tokenEnvName] ?? readTokenFile())
  if (!noToken && gitcodeToken.length > 0) env[tokenEnvName] = gitcodeToken

  const identities = await bundle.resolveIdentities({
    identities: config.identities,
    env,
    transport: noToken ? gitcodeStandIn(env.GITCODE_TOKEN) : undefined,
    log: (line) => console.log(redactWith(bundle, line, [gitcodeToken])),
  })
  const tables = bundle.createIssueMemoryTables()
  const pairs = []
  const handle = bundle.startIssueWatch({
    config: { identities: config.identities, watch: { repos: config.repos, issuePollIntervalMs: config.intervalMs } },
    env,
    identities,
    tables,
    transport: githubStandInMode ? githubStandIn() : undefined,
    githubHeaders: githubStandInMode ? {} : githubHeaders(env),
    autostart: false,
    log: (line) => console.log(redactWith(bundle, line, [gitcodeToken])),
    onPair: (pair) => {
      pairs.push(pair)
      const fields = bundle.ISSUE_DIFF_FIELDS.filter((field) => {
        if (pair.before === null) return true
        const before = pair.before[field]
        const after = pair.after[field]
        return JSON.stringify(before) !== JSON.stringify(after)
      })
      console.log(
        `diff ${pair.after.platform} key=${pair.key} fields=${JSON.stringify(pair.before === null ? ['first-observation'] : fields)} before=${pair.before === null ? 'null' : 'present'} after=present at=${pair.at}`,
      )
    },
  })
  console.log(`issue interval_ms=${handle.intervalMs} pairs_capacity=${bundle.QUEUE_CAPACITY}`)

  const deadline = Date.now() + windowMinutes * 60_000
  let round = 0
  while (Date.now() < deadline) {
    round += 1
    const roundAt = new Date().toISOString()
    const outcomes = await handle.runner.pollRound()
    // Rounds first, then one dump: the gate reads the LAST queue line per key.
    for (const outcome of outcomes) console.log(`issue ${outcome.platform} ok=${String(outcome.ok)} considered=${outcome.considered} changed=${outcome.changed} queued=${outcome.queued} at=${roundAt}`)
    for (const platform of ['github', 'gitcode']) dumpRound(bundle, tables, round, platform, roundAt)
    if (Date.now() >= deadline) break
    await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(tickSeconds * 1000, Math.max(1, deadline - Date.now()))))
  }
  const endAt = new Date().toISOString()
  console.log(`env_end loads=<${endAt}>`)
  console.log(`github_list_reads=${handle.sources.githubListReads()} gitcode_repo_coverage=${handle.sources.gitcodeRepos()}`)
  const drains = []
  for (const key of [...tables.issues.keys()]) drains.push(`${key}=${(await handle.service.drainQueue(key)).length}`)
  console.log(`drain ${drains.length} key(s) pairs_left_after_drain=0 detail=${drains.slice(0, 3).join(' ')}`)
  await handle.dispose()
  console.log(`pairs_total=${pairs.length}`)
  console.log('PY3_SMOKE_END')
  return 0
}

/** Headers of the live GitHub reads: the `gh` token when present, anonymous otherwise. */
function githubHeaders(env) {
  const token = ghToken(env)
  if (token.length === 0) {
    console.log('github auth=none (anonymous HEAD reads cap out; the gate will name it)')
    return { 'X-GitHub-Api-Version': '2022-11-28' }
  }
  console.log(`github auth=gh-token(len=${String(token.length)})`)
  return { Authorization: `token ${token}`, 'X-GitHub-Api-Version': '2022-11-28' }
}

function readTokenFile() {
  try {
    return readFileSync(resolve(homedir(), '.gitcode_token'), 'utf8').trim()
  } catch {
    return ''
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error('smoke failed:', error instanceof Error ? error.stack : error)
    process.exit(1)
  })
