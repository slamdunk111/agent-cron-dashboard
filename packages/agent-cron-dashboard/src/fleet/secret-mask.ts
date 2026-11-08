/**
 * Secret masking (P6 task 6, design §9): everything that leaves the pipeline —
 * storage rows, LLM prompts, tool text — passes through this module first.
 *
 * The pattern families match the shapes P5 measured in the real logs (tokens
 * inside JSON error bodies, credentials inside connection URLs) plus the
 * families the design names (token/key/password words, owner custom
 * fingerprints). Masking is idempotent: the replacement text never matches a
 * pattern again, so running the mask twice yields the same string.
 */
import type { ErrorSample } from '../../../../contracts/records.ts'

/** Per-sample cap (design §5.4: "样本详情按条截断（默认 4KB/条）"). */
export const SAMPLE_MAX_BYTES = 4096

/** Marker appended when a masked text was cut at {@link SAMPLE_MAX_BYTES}. */
export const TRUNCATION_MARKER = '<truncated>'

/** One mask rule: a global pattern and the text that replaces a match. */
interface MaskRule {
  readonly kind: string
  readonly pattern: RegExp
  readonly replacement: string
}

/** Families that never need the captured value (the whole match is the secret). */
const WHOLE_MATCH_RULES: readonly MaskRule[] = [
  { kind: 'key-block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replacement: '<masked:key-block>' },
  { kind: 'bearer', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]+/g, replacement: 'Bearer <masked:bearer>' },
  { kind: 'sk', pattern: /\bsk-[A-Za-z0-9-]{8,}/g, replacement: '<masked:sk>' },
  { kind: 'ghp', pattern: /\bgh[pousr]_[A-Za-z0-9]{8,}/g, replacement: '<masked:ghp>' },
  { kind: 'glpat', pattern: /\bglpat-[A-Za-z0-9_-]{8,}/g, replacement: '<masked:glpat>' },
  { kind: 'aws', pattern: /\bAKIA[0-9A-Z]{12,}/g, replacement: '<masked:aws>' },
  { kind: 'slack', pattern: /\bxox[abpsr]-[0-9A-Za-z-]{8,}/g, replacement: '<masked:slack>' },
  { kind: 'url-credential', pattern: /(?<=[a-z]{2,8}:\/\/)[^\s/@:]+:[^\s/@]+@/g, replacement: '<masked:url-credential>@' },
]

/** Assignments: keep the key word, mask the value. */
const ASSIGNMENT_RULES: readonly MaskRule[] = [
  { kind: 'assignment', pattern: /\b(password|passwd|secret|token|api[_-]?key|apikey|access[_-]?token)("?\s*[:=]\s*"?)([^\s"',;}]{3,})/gi, replacement: '$1$2<masked:assignment>' },
]

/** Placeholder for caller-supplied fingerprints (owner-specific values). */
const CUSTOM_MARKER = '<masked:custom>'

/** Escape a literal so it can be embedded in a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Mask secrets out of one string.
 * @param text - raw text (log message, tool output, prompt fragment).
 * @param extraFingerprints - owner-specific literal values to mask as well (empty or absent when unused).
 * @returns the masked text, cut at {@link SAMPLE_MAX_BYTES} with a named marker.
 */
export function maskSecrets(text: string, extraFingerprints: readonly string[] = []): string {
  let masked = text
  for (const fingerprint of extraFingerprints) {
    if (fingerprint.trim() === '') continue
    masked = masked.replace(new RegExp(escapeRegExp(fingerprint), 'g'), CUSTOM_MARKER)
  }
  for (const rule of WHOLE_MATCH_RULES) masked = masked.replace(rule.pattern, rule.replacement)
  for (const rule of ASSIGNMENT_RULES) masked = masked.replace(rule.pattern, rule.replacement)
  return masked.length <= SAMPLE_MAX_BYTES ? masked : `${masked.slice(0, SAMPLE_MAX_BYTES)}${TRUNCATION_MARKER}`
}

/**
 * Build the stored sample of one error observation (masked, bounded).
 * @param entry - message and its measured instant/severity.
 * @param extraFingerprints - owner-specific values to mask.
 */
export function sampleOf(
  entry: { readonly occurredAt: string; readonly severity: string; readonly message: string },
  extraFingerprints: readonly string[] = [],
): ErrorSample {
  return {
    occurredAt: entry.occurredAt,
    severity: entry.severity,
    message: maskSecrets(entry.message, extraFingerprints),
  }
}
