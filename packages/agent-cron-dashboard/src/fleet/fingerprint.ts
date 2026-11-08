/**
 * Error fingerprinting (P6 task 1, design §5.4): `signature = sha1(sourceId +
 * jobId + normalize(message))`.
 *
 * `normalize` turns the "skin" of a measured log line into a fixed placeholder
 * table, so two observations of the same cause collapse to one signature while
 * different causes stay apart. The rules were tuned against the P5 measured
 * samples (`fixtures/fleet/p6-fingerprint-set.json`, every case carrying its
 * `derived_from` row); the two hardest cases are the hermes `script_error`
 * lines, where the blocked script *name* is part of the cause but the account
 * number inside the path is not, and the vision errors, where the only varying
 * bytes are the timestamps and the `(0.30s)` durations.
 */
import { createHash } from 'node:crypto'
import type { ErrorEntry } from '../../../../contracts/fleet-source.ts'

/** Characters of the hex signature shown in storage keys and tool text. */
export const SIGNATURE_PREFIX = 12

/** One normalize rule; the table is the single place a rule is added. */
interface NormalizeRule {
  readonly name: string
  readonly pattern: RegExp
  readonly replacement: string
}

/**
 * The frozen rule table, applied in this order. Every rule targets a shape
 * measured in `fixtures/hermes/errors-log-sample.json`,
 * `fixtures/hermes/cron-run-events-sample.json` or
 * `fixtures/jiuwenswarm/error-landing-sample.json`:
 *
 * 1. `timestamp` — `2026-11-08 22:14:00,525`, `2026-10-26 05:01:20`, ISO with zone.
 * 2. `identifier` — hermes job ids `68f64ca3b0b1`, dated session ids `20261019_234153_47501950`
 *    (a uuid of the literal shape is covered by the same rule: `4f89` and the tail carry digits).
 * 3. `path-number` — numeric path segments (`/home/18058169312/…`, `/data_s001/18058169312/…`).
 * 4. `line-number` — `line 412`, `runner.py:87`.
 * 5. `duration` — `(0.30s)`, `after 10.0s`.
 *
 * The row-level instant (`ts`) is **not** part of the message and is deliberately not hashed:
 * a measured row differing only in its `ts` therefore collapses onto the same signature
 * (verification case S3-b is exactly that shape).
 */
const RULES: readonly NormalizeRule[] = [
  {
    name: 'timestamp',
    pattern: /(?:\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,6})?(?:Z|[+-]\d{2}:?\d{2})?))/g,
    replacement: '',
  },
  // A run of hex digits/s underscores that carries digits: hermes job ids (12 hex) and
  // dated session ids. `[0-9a-f]{6,}` alone would also eat the word "safe" … hence the digit rule.
  { name: 'identifier', pattern: /\b(?=[0-9a-f_]*\d)[0-9a-f_]{12,}\b/gi, replacement: '<id>' },
  { name: 'path-number', pattern: /(?<=\/)\d{3,}(?=\/)/g, replacement: '<num>' },
  { name: 'line-number', pattern: /\bline \d+\b/g, replacement: 'line <line>' },
  { name: 'line-number', pattern: /(\.(?:py|js|ts|sh|json|log)):\d+\b/g, replacement: '$1:<line>' },
  { name: 'duration', pattern: /(?<![A-Za-z])(?:\d+(?:\.\d+)?\s*(?:ms|s|seconds?|minutes?|hours?))(?![A-Za-z])/g, replacement: '<dur>' },
]

/**
 * Apply the rule table and collapse whitespace.
 * @param message - the raw (already masked) error message.
 * @returns the normalized message; never empty for non-empty input.
 */
export function normalize(message: string): string {
  let text = message
  for (const rule of RULES) text = text.replace(rule.pattern, rule.replacement)
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Compute the fingerprint of one error observation.
 * @param entry - the source/job identity and the masked message.
 * @returns lowercase hex sha1 of `sourceId \0 jobId \0 normalized`.
 */
export function signatureOf(entry: Pick<ErrorEntry, 'sourceId' | 'jobId' | 'message'>): string {
  const normalized = normalize(entry.message)
  return createHash('sha1').update(`${entry.sourceId}\0${entry.jobId ?? ''}\0${normalized}`).digest('hex')
}

/** One case of the verification sheet. */
export interface FingerprintCase {
  readonly id: string
  readonly group: string
  readonly expect: 'same' | 'diff'
  readonly cause: string
  readonly sourceId: string
  readonly jobId: string
  readonly message: string
  readonly transform: string
  readonly derived_from: { readonly file: string; readonly path: string; readonly ts?: string }
}

/** The verification sheet file shape. */
export interface FingerprintSet {
  readonly version: number
  readonly cases: readonly FingerprintCase[]
  readonly sameCauseGroups: readonly { readonly id: string; readonly cases: readonly string[] }[]
}

/** Per-case verdict of the sheet. */
export interface FingerprintCaseVerdict {
  readonly id: string
  readonly group: string
  readonly expect: 'same' | 'diff'
  readonly signature: string
  readonly verdict: 'PASS' | 'FAIL'
  readonly cause: string
}

/** Sheet verdict: hits, misses, and the recorded misses (the tuning evidence). */
export interface FingerprintVerdict {
  readonly sameCauseMerged: number
  readonly sameCauseTotal: number
  readonly differentCauseSeparated: number
  readonly differentCauseTotal: number
  readonly hitRate: number
  readonly cases: readonly FingerprintCaseVerdict[]
  readonly errors: readonly { readonly id: string; readonly expect: 'same' | 'diff'; readonly actual: string; readonly cause: string }[]
}

/**
 * Evaluate the sheet: same-cause members must share one signature, different
 * causes must not share one. The miss list is returned verbatim so a tuning
 * pass can cite every failure instead of only the aggregate.
 * @param set - the verification sheet.
 */
export function evaluateSamples(set: FingerprintSet): FingerprintVerdict {
  const signatures = new Map<string, string>()
  for (const entry of set.cases) {
    signatures.set(entry.id, signatureOf({ sourceId: entry.sourceId, jobId: entry.jobId, message: entry.message }))
  }
  const cases: FingerprintCaseVerdict[] = []
  const errors: { id: string; expect: 'same' | 'diff'; actual: string; cause: string }[] = []
  let sameMerged = 0
  for (const group of set.sameCauseGroups) {
    const members = group.cases.map((id) => set.cases.find((entry) => entry.id === id)).filter((entry): entry is FingerprintCase => entry !== undefined)
    const merged = new Set(members.map((entry) => signatures.get(entry.id))).size === 1
    let failed = 0
    for (const entry of members) {
      const pass = entry.expect === 'same' && merged
      cases.push({ id: entry.id, group: entry.group, expect: entry.expect, signature: signatures.get(entry.id) ?? '', verdict: pass ? 'PASS' : 'FAIL', cause: entry.cause })
      if (!pass) {
        failed += 1
        errors.push({ id: entry.id, expect: entry.expect, actual: signatures.get(entry.id) ?? '', cause: entry.cause })
      }
    }
    if (failed === 0) sameMerged += members.length
  }
  const diffCases = set.cases.filter((entry) => entry.expect === 'diff')
  let separated = 0
  for (const entry of diffCases) {
    const signature = signatures.get(entry.id) ?? ''
    const clash = set.sameCauseGroups.flatMap((group) => group.cases).find((id) => signatures.get(id) === signature)
    const pass = clash === undefined
    cases.push({ id: entry.id, group: entry.group, expect: entry.expect, signature, verdict: pass ? 'PASS' : 'FAIL', cause: entry.cause })
    if (pass) separated += 1
    else errors.push({ id: entry.id, expect: entry.expect, actual: signature, cause: entry.cause })
  }
  const sameTotal = set.cases.filter((entry) => entry.expect === 'same').length
  const diffTotal = diffCases.length
  const total = sameTotal + diffTotal
  return {
    sameCauseMerged: sameMerged,
    sameCauseTotal: sameTotal,
    differentCauseSeparated: separated,
    differentCauseTotal: diffTotal,
    hitRate: total === 0 ? 0 : Math.round(((sameMerged + separated) / total) * 10_000) / 100,
    cases,
    errors,
  }
}
