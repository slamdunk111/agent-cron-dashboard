/**
 * Event-key codec for `workbench_events` (P6).
 *
 * The documented shape is `<at>|<subjectKey>|<kind>|<n>` (P4/P5 use it verbatim
 * in their in-memory fixtures). The JSON per-record layout of this domain only
 * accepts `[a-zA-Z0-9_-]+` (measured: `dsh-storage-json` `assertSafeKey` rejects
 * `|`, `/` and `:`; `/` is even its layout path separator), so the written key
 * is the **encoded** form:
 *
 *   `<instant>W<subject>V<kind>X<n>`
 *
 * Four segments in their documented order. `W`, `V`, `X` are the segment markers
 * and `…X<n>` closes with the fourth documented segment. Every escape target
 * lies in its own letter band, is **different from every marker**, and produces
 * a letter that does not otherwise occur in that segment:
 *
 * | segment | what it may carry | escape letters |
 * |---|---|---|
 * | instant | digits, `T`, `Z`, `.`, `-`, `:`, `+` | `:` → `c`, `+` → `d`, `.` → `D`, `-` → `F` |
 * | subject | config-pattern chars plus `/` | `/` → `S`, `.` → `T`, `-` → `U` |
 * | kind | fleet kinds (letters + `-`) | `-` → `M` |
 *
 * `W` = 0x57, `V` = 0x56, `X` = 0x58; the escape bands are `[c-f]`, `[S-U]` and
 * `M`, all disjoint from one another and from the markers. The counter is digits
 * after the final marker.
 *
 * Codec invariant (asserted in `test/fleet-error-pipeline.test.ts`): each marker
 * occurs exactly once in a written key and no escape letter can be mistaken for
 * a marker, so `decodeEventKey` splits at the markers and inverts each map.
 */

/** Markers: instant join, subject join, kind join. */
const MARKER = { instant: 'W', subject: 'V', kind: 'X' } as const

/** Escape maps per segment kind (source character → escape letter). */
export const ESCAPE_TABLES = {
  instant: { ':': 'c', '+': 'd', '.': 'D', '-': 'F' },
  subject: { '/': 'S', '.': 'T', '-': 'U' },
  kind: { '-': 'M' },
} as const satisfies Record<string, Record<string, string>>

/** The four segments a stored key carries. */
export interface EventKeyParts {
  readonly at: string
  readonly subjectKey: string
  readonly kind: string
  readonly index: number
}

/** Apply one escape map character by character. */
function escapeWith(value: string, map: Record<string, string>): string {
  let out = ''
  for (const char of value) out += map[char] ?? char
  return out
}

/** Invert one escape map; a letter outside the targets is left as it is. */
function unescapeWith(value: string, map: Record<string, string>): string {
  const inverse = new Map(Object.entries(map).map(([from, to]) => [to, from]))
  let out = ''
  for (const char of value) out += inverse.get(char) ?? char
  return out
}

/**
 * Build the stored key for one event.
 * @param at - ISO 8601 instant (the first documented segment).
 * @param subjectKey - storage key of the subject (`error/<recordId>`).
 * @param kind - change kind (the fleet catalog).
 * @param index - monotone counter (the fourth documented segment).
 */
export function eventKeyOf(at: string, subjectKey: string, kind: string, index: number): string {
  return `${escapeWith(at, ESCAPE_TABLES.instant)}${MARKER.instant}${escapeWith(subjectKey, ESCAPE_TABLES.subject)}${MARKER.subject}${escapeWith(kind, ESCAPE_TABLES.kind)}${MARKER.kind}${String(index)}`
}

/**
 * Split a stored key back into its four segments.
 * @param key - the stored key.
 * @returns the segments, or null for any key that this codec did not write.
 */
export function decodeEventKey(key: string): EventKeyParts | null {
  const cutInstant = key.indexOf(MARKER.instant)
  const cutSubject = key.indexOf(MARKER.subject, cutInstant + 1)
  const cutKind = key.indexOf(MARKER.kind, cutSubject + 1)
  if (cutInstant <= 0 || cutSubject <= cutInstant || cutKind <= cutSubject) return null
  const index = Number(key.slice(cutKind + 1))
  if (!Number.isInteger(index) || index <= 0) return null
  return {
    at: unescapeWith(key.slice(0, cutInstant), ESCAPE_TABLES.instant),
    subjectKey: unescapeWith(key.slice(cutInstant + 1, cutSubject), ESCAPE_TABLES.subject),
    kind: unescapeWith(key.slice(cutSubject + 1, cutKind), ESCAPE_TABLES.kind),
    index,
  }
}
