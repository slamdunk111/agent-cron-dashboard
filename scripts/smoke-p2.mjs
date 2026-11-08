#!/usr/bin/env node
/**
 * Real-machine smoke of the P2 chain (plan §5.0–§5.2).
 *
 * Runs identity → seeding → watch against the live hosts and writes one log the
 * gates read. It uses the shipped modules with injectable transports, so the
 * log lines are exactly what the row would print:
 *   - `identity <platform> state=…` from `resolveIdentities`
 *   - `seed <platform>=[…]` from the seeding outcome
 *   - `round#N platform=…`, `snapshot=<key> …` from the watch service
 *   - `EXIT rc=` appended by the shell template, not by this script
 *
 * Usage:
 *   node scripts/smoke-p2.mjs --config fixtures/p2-smoke-config.yaml [--window-minutes=30]
 *   node scripts/smoke-p2.mjs --no-token
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

async function loadModule() {
  // The freshly built bundle is what dsh mounts; the smoke needs its exports.
  const built = resolve(import.meta.dirname, '../build/packages/agent-cron-dashboard/index.js')
  return import(built)
}

/** Redact through the bundle's helper (the single redaction rule lives there). */
function redactWith(bundle, line, secrets) {
  // Only refusal lines can echo a token; redacting every line turned substrings
  // like `#97` into `#***` (a 1-char secret). Long tokens only, refusal lines only.
  const long = secrets.filter((value) => typeof value === 'string' && value.length >= 12)
  if (!line.includes('refused') && !line.includes('invalid token')) return line
  return typeof bundle.redact === 'function' ? bundle.redact(line, long) : line
}

function argOf(argv, name, fallback) {
  const index = argv.indexOf(name)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}

function configOf(path) {
  const text = readFileSync(resolve(path), 'utf8')
  const repos = text
    .split('\n')
    .filter((line) => line.trim().startsWith('- https'))
    .map((line) => line.trim().slice(2).trim())
  const identities = [
    { platform: 'github', username: /platform: github[\s\S]*?username: ([A-Za-z0-9_.-]+)/.exec(text)?.[1] },
    { platform: 'gitcode', username: /platform: gitcode[\s\S]*?username: ([A-Za-z0-9_.-]+)/.exec(text)?.[1], tokenEnv: 'GITCODE_TOKEN' },
  ]
  return { repos, identities }
}

/** Seeding transport: the offline stand-in during G2, the real one otherwise. */
function gitcodeTransport(noToken, env) {
  if (!noToken) return undefined
  const fake = env.GITCODE_TOKEN ?? 'XAI_P2_CANARY'
  return {
    async get(url) {
      if (url.includes('/api/v5/user')) return { status: 403, text: JSON.stringify({ error_message: `invalid token: ${fake}` }) }
      return { status: 403, text: JSON.stringify({ error_message: 'no scopes:read_user' }) }
    },
  }
}

async function main(argv) {
  const bundle = await loadModule()
  const configPath = argOf(argv, '--config', resolve(import.meta.dirname, '../fixtures/p2-smoke-config.yaml'))
  const { repos, identities: identityRows } = configOf(configPath)
  const noToken = argv.includes('--no-token')
  const windowMinutes = Number(argOf(argv, '--window-minutes', '30'))
  const gitcodeInterval = Number(argOf(argv, '--gitcode-interval-ms', '10000'))
  const githubInterval = Number(argOf(argv, '--github-interval-ms', '60000'))
  const env = { ...process.env }
  if (noToken) {
    // The stand-in echoes the received token back; redact turns it into `***`.
    env.GITCODE_TOKEN = process.env.P2_CANARY ?? 'XAI_P2_CANARY'
  }

  const identities = await bundle.resolveIdentities({
    identities: identityRows,
    env,
    transport: gitcodeTransport(noToken, env),
    log: (line) => console.log(redactWith(bundle, line, [env.GITCODE_TOKEN])),
  })
  const outcome = await bundle.seedPullRequests({
    repos,
    identities,
    identitiesConfig: identityRows,
    env,
    log: (line) => console.log(redactWith(bundle, line, [env.GITCODE_TOKEN])),
  })
  console.log(`seed github=${JSON.stringify(outcome.seeded.filter((item) => item.platform === 'github').map((item) => `${item.owner}/${item.repo}#${item.number}`).sort())}`)
  console.log(`seed gitcode=${JSON.stringify(outcome.seeded.filter((item) => item.platform === 'gitcode').map((item) => `${item.owner}/${item.repo}#${item.number}`).sort())}`)

  if (noToken) {
    console.log('PY2_SMOKE_END')
    return 0
  }

  const tables = bundle.createMemoryTables()
  const sources = {}
  const gitcode = await bundle.makeGitCodeWatchSource({ intervalMs: gitcodeInterval })
  sources.gitcode = gitcode
  const github = new bundle.GithubProvider({ intervalMs: githubInterval, runner: undefined, log: (line) => console.log(line) })
  sources.github = { subscribe: (ref, listener) => github.subscribe(ref, listener) }
  const watch = bundle.makePrWatchService({ prTable: tables.prTable, cursors: tables.cursors, sources, env, onPair: () => {} })
  const refs = outcome.seeded.map((item) => ({ platform: item.platform, owner: item.owner, repo: item.repo, number: item.number }))
  watch.applyWatchSet(refs)
  const deadline = Date.now() + windowMinutes * 60_000
  while (Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000))
    for (const entry of tables.prs.entries()) {
      const snapshot = entry[1]
      console.log(`snapshot=${entry[0]} state=${snapshot.state} rollup=${snapshot.checksRollup} at=${new Date().toISOString()}`)
    }
  }
  watch.dispose()
  gitcode.dispose()
  console.log('PY2_SMOKE_END')
  return 0
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error('smoke failed:', error instanceof Error ? error.stack : error)
    process.exit(1)
  })
