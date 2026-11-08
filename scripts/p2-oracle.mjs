#!/usr/bin/env node
/**
 * Independent oracle for G1 (plan §3.2 / §5.1).
 *
 * Reads the same list shape seeding reads — `state=open`, `per_page=50`,
 * author filter — but with its **own** HTTP code: it never imports the
 * seeding module, so a bug in one cannot hide in the other. Writes the
 * expected sets to two JSON files and, in `probe-perpage` mode, measures the
 * page-size ceiling the plan cites.
 *
 * Usage:
 *   node scripts/p2-oracle.mjs --platform both --out ../docs/handoff/p2-oracle-github.json --out-gitcode ../docs/handoff/p2-oracle-gitcode.json
 *   node scripts/p2-oracle.mjs --mode probe-perpage
 *   node scripts/p2-oracle.mjs --mode mitm-none --out ../docs/handoff/p2-oracle-anon.json
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'

const PER_PAGE = 50
const GITCODE_MAX_PAGES = 3

function argOf(argv, name, fallback) {
  const index = argv.indexOf(name)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}

function token() {
  if (typeof process.env.GITCODE_TOKEN === 'string' && process.env.GITCODE_TOKEN.length > 0) return process.env.GITCODE_TOKEN
  try {
    return readFileSync(resolve(homedir(), '.gitcode_token'), 'utf8').trim()
  } catch {
    return undefined
  }
}

function repoConfig(path) {
  // `fixtures/p2-smoke-config.yaml` keeps only two keys the script needs.
  const text = readFileSync(resolve(path), 'utf8')
  const repos = [...text.matchAll(/- (?:https?:\/\/)?(github\.com|gitcode\.com)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/g)].map((match) => ({
    host: match[1],
    owner: match[2],
    name: match[3],
  }))
  const github = /platform:\s*github[\s\S]*?username:\s*([A-Za-z0-9_.-]+)/.exec(text)?.[1]
  const gitcode = /platform:\s*gitcode[\s\S]*?username:\s*([A-Za-z0-9_.-]+)/.exec(text)?.[1]
  return { repos, githubLogin: github, gitcodeLogin: gitcode }
}

async function getJson(url, headers) {
  const response = await fetch(url, { headers: { ...headers, 'User-Agent': 'p2-oracle' }, redirect: 'manual' })
  return { status: response.status, link: response.headers.get('link'), body: await response.text() }
}

/** One repository's open authored requests, read independently of seeding. */
async function listOpenAuthored(repo, login, mode) {
  if (repo.host === 'github.com') {
    const { execFileSync } = await import('node:child_process')
    const apiPath = `repos/${repo.owner}/${repo.name}/pulls?state=open&per_page=${PER_PAGE}&page=1`
    const out = execFileSync('gh', ['api', '-H', 'Accept: application/vnd.github+json', apiPath], { encoding: 'utf8', timeout: 40_000 })
    const rows = JSON.parse(out)
    const numbers = rows.filter((row) => row.user?.login === login).map((row) => row.number)
    return { numbers, pages: 1, note: null }
  }
  const headers = mode === 'mitm-none' ? { Accept: 'application/json' } : { Accept: 'application/json', 'private-token': token() ?? '' }
  const numbers = []
  for (let page = 1; page <= GITCODE_MAX_PAGES; page += 1) {
    const result = await getJson(`https://gitcode.com/api/v5/repos/${repo.owner}/${repo.name}/pulls?state=open&per_page=${PER_PAGE}&page=${page}`, headers)
    if (result.status !== 200) return { numbers: [], pages: page, note: `HTTP ${result.status}` }
    const rows = JSON.parse(result.body)
    for (const row of rows) {
      if (row.user?.login !== login) continue
      if (row.state !== 'open') continue
      if (typeof row.merged_at === 'string' && row.merged_at.length > 0) continue
      numbers.push(row.number)
    }
    if (rows.length < PER_PAGE) break
    if (page === GITCODE_MAX_PAGES) return { numbers, pages: page, note: `${GITCODE_MAX_PAGES} full pages` }
  }
  return { numbers, pages: GITCODE_MAX_PAGES, note: null }
}

async function main(argv) {
  const mode = argOf(argv, '--mode', 'oracle')
  const configPath = argOf(argv, '--config', resolve('fixtures/p2-smoke-config.yaml'))
  const at = new Date().toISOString()

  if (mode === 'probe-perpage') {
    const tokenValue = token()
    for (const size of [3, 20, 50, 100]) {
      const result = await getJson(`https://gitcode.com/api/v5/repos/openJiuwen/jiuwenswarm/pulls?state=all&per_page=${size}&page=1`, { Accept: 'application/json', 'private-token': tokenValue ?? '' })
      const rows = result.status === 200 ? JSON.parse(result.body) : []
      console.log(`per_page ${size} -> rows ${rows.length}`)
    }
    return 0
  }

  if (mode === 'mitm-none') {
    const result = await getJson('https://gitcode.com/api/v5/user', { Accept: 'application/json' })
    const out = argOf(argv, '--out', resolve('../docs/handoff/p2-oracle-anon.json'))
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, JSON.stringify({ status: result.status, body: result.body, at }, null, 2) + '\n')
    console.log(`anonymous /user -> ${result.status} ${result.body.slice(0, 120)}`)
    return result.status === 403 ? 0 : 1
  }

  const config = repoConfig(configPath)
  const platform = argOf(argv, '--platform', 'both')
  const sets = { github: [], gitcode: [] }
  const notes = []
  for (const repo of config.repos) {
    const login = repo.host === 'github.com' ? config.githubLogin : config.gitcodeLogin
    if (login === undefined) {
      notes.push(`${repo.owner}/${repo.name}: no configured login`)
      continue
    }
    const listed = await listOpenAuthored(repo, login, mode)
    if (listed.note !== null) notes.push(`${repo.owner}/${repo.name}: ${listed.note}`)
    const bucket = repo.host === 'github.com' ? sets.github : sets.gitcode
    for (const number of listed.numbers) bucket.push(`${repo.owner}/${repo.name}#${number}`)
  }
  sets.github.sort()
  sets.gitcode.sort()
  const write = (path, body) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(body, null, 2) + '\n')
    console.log(`${path}: ${JSON.stringify(body)}`)
  }
  if (platform === 'both' || platform === 'github') write(argOf(argv, '--out', resolve('../docs/handoff/p2-oracle-github.json')), { at, github: sets.github, notes })
  if (platform === 'both' || platform === 'gitcode') write(argOf(argv, '--out-gitcode', resolve('../docs/handoff/p2-oracle-gitcode.json')), { at, gitcode: sets.gitcode, notes })
  return 0
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error('oracle failed:', error instanceof Error ? error.message : error)
    process.exit(1)
  })
