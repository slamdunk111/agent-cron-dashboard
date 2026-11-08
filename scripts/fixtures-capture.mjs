#!/usr/bin/env node
/**
 * Re-capture the P2 fixtures from the live APIs (plan §1, delivered with pen 1).
 *
 * The fixtures are samples, not live reads: this script writes them once, keeps
 * the capture time inside each file (`_capturedAt`), and redacts the token
 * before anything reaches disk. Live values move (a GitHub status list turns
 * from empty to populated), so the gate replays these files instead of
 * re-reading the network.
 *
 * Usage:
 *   GITCODE_TOKEN=... node scripts/fixtures-capture.mjs --repo dptech-corp/Uni-Core --pr 75
 *   node scripts/fixtures-capture.mjs --gitcode openJiuwen/jiuwenswarm --out fixtures/gitcode
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const at = new Date().toISOString()

function argOf(argv, name, fallback) {
  const index = argv.indexOf(name)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}

async function ghJson(apiPath) {
  const out = execFileSync('gh', ['api', '-H', 'Accept: application/vnd.github+json', apiPath], { encoding: 'utf8', timeout: 40_000 })
  return JSON.parse(out)
}

function slimPull(pull, source) {
  return {
    number: pull.number,
    state: pull.state,
    draft: pull.draft,
    merged_at: pull.merged_at,
    closed_at: pull.closed_at,
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    html_url: pull.html_url,
    title: pull.title,
    additions: pull.additions,
    deletions: pull.deletions,
    user: { login: pull.user?.login },
    head: { ref: pull.head?.ref, sha: pull.head?.sha, label: pull.head?.label, repo: { owner: { login: pull.head?.repo?.owner?.login } } },
    base: { ref: pull.base?.ref },
    labels: (pull.labels ?? []).map((label) => ({ name: label.name })),
    _capturedAt: at,
    _source: source,
  }
}

async function captureGithub(argv) {
  const repo = argOf(argv, '--repo', 'dptech-corp/Uni-Core')
  const pr = Number(argOf(argv, '--pr', '75'))
  const outDir = resolve(root, 'fixtures/github')
  mkdirSync(outDir, { recursive: true })
  const pull = await ghJson(`repos/${repo}/pulls/${pr}`)
  const sha = pull.head.sha
  const status = await ghJson(`repos/${repo}/commits/${sha}/status`)
  const checks = await ghJson(`repos/${repo}/commits/${sha}/check-runs`)
  const reviews = await ghJson(`repos/${repo}/pulls/${pr}/reviews`)
  const listUrl = `repos/${repo}/pulls?state=open&per_page=50&page=1`
  const list = execFileSync('gh', ['api', '-H', 'Accept: application/vnd.github+json', listUrl], { encoding: 'utf8', timeout: 40_000 })
  writeFileSync(resolve(outDir, `pull-${pr}.json`), JSON.stringify(slimPull(pull, `GET ${listUrl.replace(/\?.*/, '')}/${pr}`), null, 2) + '\n')
  writeFileSync(
    resolve(outDir, `status-${repo.split('/')[1].toLowerCase()}-${pr}.json`),
    JSON.stringify(
      {
        state: status.state,
        total_count: status.total_count,
        statuses: (status.statuses ?? []).map((row) => ({ context: row.context, state: row.state })),
        check_total_count: checks.total_count,
        check_conclusions: [...new Set((checks.check_runs ?? []).map((row) => row.conclusion))].sort(),
        reviews_states: (reviews ?? []).map((review) => review.state),
        _sha: sha,
        _capturedAt: at,
      },
      null,
      2,
    ) + '\n',
  )
  const rows = [];
  for (const line of list.split('\n')) {
    if (line.trim().length === 0) continue
    try {
      rows.push(JSON.parse(line))
    } catch {
      // `gh api` prints one JSON document per page; a list answer is one array.
    }
  }
  const listBody = JSON.parse(list)
  writeFileSync(
    resolve(outDir, `pulls-${repo.split('/')[1].toLowerCase()}.json`),
    JSON.stringify(listBody.map((entry) => slimPull(entry, `GET ${listUrl}`)), null, 2) + '\n',
  )
  console.log(`captured GitHub fixtures for ${repo}#${pr} at ${at}`)
}

async function captureGitcode(argv) {
  const target = argOf(argv, '--gitcode', 'openJiuwen/jiuwenswarm')
  const outDir = resolve(root, 'fixtures/gitcode')
  mkdirSync(outDir, { recursive: true })
  const token = process.env.GITCODE_TOKEN ?? readFileSync(resolve(homedir(), '.gitcode_token'), 'utf8').trim()
  const headers = { Accept: 'application/json', 'private-token': token, 'User-Agent': 'fixtures-capture' }
  const get = async (url) => JSON.parse(await (await fetch(url, { headers })).text())
  const [owner, name] = target.split('/')
  const list = await get(`https://gitcode.com/api/v5/repos/${owner}/${name}/pulls?state=open&per_page=50&page=1`)
  writeFileSync(
    resolve(outDir, `pull-list-${name}.json`),
    JSON.stringify({ _capturedAt: at, _source: `GET /repos/${owner}/${name}/pulls?state=open&per_page=50&page=1`, items: list.map((pull) => slimPull(pull, 'gitcode')) }, null, 2) + '\n',
  )
  console.log(`captured GitCode fixtures for ${target} at ${at}`)
}

const argv = process.argv.slice(2)
const task = argv.includes('--gitcode') ? captureGitcode : captureGithub
task(argv).catch((error) => {
  console.error('capture failed:', error instanceof Error ? error.message : error)
  process.exit(1)
})
