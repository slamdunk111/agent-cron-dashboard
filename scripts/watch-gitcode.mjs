#!/usr/bin/env node
/**
 * Live poll of one GitCode change request through the built provider.
 *
 * Proves the P1 gate "a watched GitCode PR produces a snapshot with a non-empty
 * CI state within the poll window" without needing a forge-mounted host: it
 * drives the provider's `fetch` directly with the same code path dsh uses.
 *
 * Usage: node scripts/watch-gitcode.mjs [owner/repo#number] [seconds]
 *   default: openJiuwen/jiuwenswarm#9723, 60 s, polling every 10 s. The interval
 *   is deliberately far under the plan's 30-minute window, so the gate ("a
 *   snapshot within 30 minutes") is met on the first poll.
 */
import { makeGitCodeProvider, validateConfig } from '../build/packages/dsh-forge-gitcode/index.js'

const target = process.argv[2] ?? 'openJiuwen/jiuwenswarm#9723'
const seconds = Number(process.argv[3] ?? 60)
const [, ownerRepo, rawNumber] = /^([^#]+)#(\d+)$/.exec(target) ?? []
if (ownerRepo === undefined || rawNumber === undefined) {
  console.error('usage: node scripts/watch-gitcode.mjs owner/repo#number [seconds]')
  process.exit(2)
}
const [owner, name] = ownerRepo.split('/')
const ref = { repository: { forge: 'gitcode', host: 'gitcode.com', owner, name }, number: Number(rawNumber) }
const provider = makeGitCodeProvider(validateConfig({}))

const deadline = Date.now() + seconds * 1000
let snapshot
while (Date.now() < deadline) {
  const controller = new AbortController()
  const result = await provider.fetch([ref], controller.signal)
  const value = [...result.values()][0]
  if (value !== undefined && 'code' in value) {
    console.log(JSON.stringify({ at: new Date().toISOString(), failure: value }))
  } else {
    snapshot = value
    console.log(
      JSON.stringify({
        at: new Date().toISOString(),
        state: snapshot.state,
        draft: snapshot.draft,
        mergeability: snapshot.mergeability,
        mergeReady: snapshot.mergeReady,
        checksRollup: snapshot.checksRollup,
        checks: snapshot.checks.length,
        headSha: snapshot.headSha,
        lines: `${snapshot.additions}/-${snapshot.deletions}`,
      }),
    )
    // The gate wants a non-empty CI field; stop as soon as one snapshot has it.
    if (snapshot.checks.length > 0 && snapshot.checksRollup !== 'none') break
  }
  await new Promise((resolve) => setTimeout(resolve, 10_000))
}
process.exit(snapshot !== undefined && snapshot.checks.length > 0 ? 0 : 1)
