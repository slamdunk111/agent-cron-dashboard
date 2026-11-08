import { describe, expect, it } from 'vitest'
import { parseLogLines } from '../packages/agent-cron-dashboard/src/fleet/log-tail.ts'
import { maskSecrets, sampleOf, SAMPLE_MAX_BYTES } from '../packages/agent-cron-dashboard/src/fleet/secret-mask.ts'

/** One measured hermes line, already redacted by P5 (fixtures/hermes/errors-log-sample.json lines[15]). */
const MEASURED =
  'Tool vision_analyze returned error (0.12s): {'

describe('secret-mask (P6 task 6): every pattern family, idempotent, bounded', () => {
  it('masks a bearer token', () => {
    expect(maskSecrets('Authorization: Bearer abcdef123456')).toBe('Authorization: Bearer <masked:bearer>')
  })

  it('masks provider key prefixes (sk/ghp/glpat/aws/slack)', () => {
    const masked = maskSecrets('sk-live-1234567890abcdef ghp_abcdefghijklmnopqrstuvwxyz0123 glpat-abcdefghij AKIAABCDEFGHIJKLMNOP xoxb-1234567890-abcdefghij')
    for (const token of ['sk-live', 'ghp_', 'glpat-', 'AKIA', 'xoxb-']) expect(masked).not.toContain(token)
    expect(masked.split('<masked:')).toHaveLength(6)
  })

  it('masks the value side of credential assignments', () => {
    const masked = maskSecrets('password=hunter2 token: "abcdef123456" api_key=XYZsecret')
    expect(masked).not.toContain('hunter2')
    expect(masked).not.toContain('abcdef123456')
    expect(masked).not.toContain('XYZsecret')
    expect(masked).toContain('password=<masked:assignment>')
  })

  it('masks private key blocks', () => {
    const masked = maskSecrets('-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n-----END RSA PRIVATE KEY-----')
    expect(masked).not.toContain('MIIEow==')
    expect(masked).toContain('<masked:key-block>')
  })

  it('masks credentials embedded in URLs', () => {
    expect(maskSecrets('https://user:p4ssw0rd@example.com/v1')).toBe('https://<masked:url-credential>@example.com/v1')
  })

  it('masks caller-supplied extra fingerprints', () => {
    expect(maskSecrets('remote said OWR-8891 twice', ['OWR-8891'])).toBe('remote said <masked:custom> twice')
    expect(maskSecrets('remote said OWR-8891 twice', [])).toBe('remote said OWR-8891 twice')
  })

  it('is idempotent: masking twice changes nothing', () => {
    const once = maskSecrets('password=hunter2 ghp_abcdefghijklmnopqrstuvwxyz0123')
    expect(maskSecrets(once)).toBe(once)
  })

  it('leaves the measured P5 sample message intact', () => {
    expect(maskSecrets(MEASURED)).toBe(MEASURED)
  })

  it('leaves ordinary error text intact', () => {
    const text = 'Blocked: script path resolves outside the scripts directory (/data_s001/18058169312/openclaw-data/.hermes/scripts)'
    expect(maskSecrets(text)).toBe(text)
  })

  it('truncates beyond the per-sample cap and names the cut', () => {
    const long = 'x'.repeat(SAMPLE_MAX_BYTES + 100)
    const masked = maskSecrets(long)
    expect(masked.endsWith('<truncated>')).toBe(true)
    expect(masked.length).toBeLessThan(long.length)
    expect(masked.slice(0, SAMPLE_MAX_BYTES).length).toBe(SAMPLE_MAX_BYTES)
  })

  it('never stores a truncated sample past the cap', () => {
    const parsed = parseLogLines('hermes-errors', [`2026-11-07 16:03:18,229 ERROR tools.vision_tools: ${'y'.repeat(SAMPLE_MAX_BYTES + 10)}`])
    const sample = sampleOf({ occurredAt: parsed[0]!.occurredAt, severity: 'error', message: parsed[0]!.message })
    expect(sample.message.endsWith('<truncated>')).toBe(true)
    expect(sample.message.length).toBe(SAMPLE_MAX_BYTES + '<truncated>'.length)
  })
})

describe('secret-mask sampleOf: ErrorSample from a parsed line', () => {
  it('keeps the measured message and the parsed instant', () => {
    const sample = sampleOf({ occurredAt: '2026-11-05T19:30:42.378+08:00', severity: 'warning', message: MEASURED })
    expect(sample).toEqual({ occurredAt: '2026-11-05T19:30:42.378+08:00', severity: 'warning', message: MEASURED })
  })

  it('masks before storing', () => {
    const sample = sampleOf({ occurredAt: '2026-11-05T19:30:42.378+08:00', severity: 'error', message: 'token=abcdef123456 failed' })
    expect(sample.message).not.toContain('abcdef123456')
  })
})
