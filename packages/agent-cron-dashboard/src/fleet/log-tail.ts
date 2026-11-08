/**
 * Log tail with a byte-offset cursor and rotation detection (P5, probes §7).
 *
 * The adapters never stream a whole log: each tick reads the tail window
 * (`tail -c <window>` / `stat` / `wc -c`) and this module decides what part of
 * that window is new. Rotation (inode change) and truncation (same inode, smaller
 * size) both reset the offset; a gap larger than the window is reported as
 * `dropped` so the watch counts it instead of silently losing lines.
 */

/** What the last read left behind: the size and the inode identity of the file. */
export interface FileMark {
  readonly size: number
  /** `<device>.<inode>` from `stat -c '%d %i'`, or any adapter-chosen identity. */
  readonly inode: string
}

/** One tail step. */
export interface TailResult {
  /** New complete lines (the tail window sliced at the offset). */
  readonly text: string
  /** Mark to persist for the next call. */
  readonly next: FileMark
  /** Byte offset the next call starts from. */
  readonly offset: number
  /** True when the inode changed or the size shrank (the file was rotated or truncated). */
  readonly rotated: boolean
  /** True when the unseen gap was larger than the window and the head of it was lost. */
  readonly dropped: boolean
}

/** One parsed log line (before the adapter maps it to an `ErrorEntry`). */
export interface ParsedLogLine {
  /** ISO 8601 occurrence time. */
  readonly occurredAt: string
  readonly level: 'info' | 'warning' | 'error' | 'critical'
  /** Logger/module that emitted the line. */
  readonly logger: string
  readonly message: string
}

const LEVELS: Readonly<Record<string, ParsedLogLine['level']>> = {
  DEBUG: 'info',
  INFO: 'info',
  WARNING: 'warning',
  WARN: 'warning',
  ERROR: 'error',
  CRITICAL: 'critical',
}

/** `2026-11-08 22:14:00,525` → `2026-11-08T22:14:00.525+08:00`. */
const HERMES_LINE_RE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2},\d{3})\s+(DEBUG|INFO|WARNING|WARN|ERROR|CRITICAL)\s+([^:]+?)(?::\s+\[[^\]]*\])?\s*:\s*(.*)$/

/** `2026-11-06 15:07:35 | tool | trace | ERROR | {json}`. */
const PIPE_LINE_RE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.\d{3})? \| ([^|]+?) \| ([^|]+?) \| (DEBUG|INFO|WARNING|WARN|ERROR|CRITICAL) \| (.*)$/

/** ISO with the machine's current offset; the log timestamps carry no zone. */
function isoAt(datePart: string, timePart: string): string {
  // both line shapes carry millisecond precision (hermes `,...`, pipe `.ddd`)
  const millis = timePart.replace(',', '.')
  const minutes = -new Date().getTimezoneOffset()
  const sign = minutes >= 0 ? '+' : '-'
  const abs = Math.abs(minutes)
  const zone = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
  return `${datePart}T${millis}${zone}`
}

/**
 * Slice the tail window at the persisted offset and decide rotation/truncation.
 * @param mark - last persisted mark (`null` on the first read).
 * @param current - the file's current `stat` (size + inode identity).
 * @param windowText - the last `windowBytes` of the file (may be shorter than the window).
 * @param windowBytes - the window size the caller asked for.
 */
export function advance(mark: FileMark | null, current: FileMark, windowText: string, windowBytes: number): TailResult {
  const next: FileMark = { size: current.size, inode: current.inode }
  if (mark === null) {
    return { text: windowText, next, offset: current.size, rotated: false, dropped: false }
  }
  if (mark.inode !== current.inode || current.size < mark.size) {
    return { text: windowText, next, offset: current.size, rotated: true, dropped: false }
  }
  const delta = current.size - mark.size
  if (delta === 0) return { text: '', next, offset: current.size, rotated: false, dropped: false }
  const provided = Math.max(0, windowText.length)
  if (delta > windowBytes) {
    // The gap is larger than the window: keep the tail of the window, report the loss.
    const keep = Math.max(0, provided - windowBytes + Math.min(windowBytes, provided))
    return { text: windowText.slice(Math.max(0, provided - Math.min(windowBytes, keep)), provided), next, offset: current.size, rotated: false, dropped: true }
  }
  const back = provided - delta
  return { text: windowText.slice(Math.max(0, back)), next, offset: current.size, rotated: false, dropped: false }
}

/**
 * Parse the two log shapes measured in probes (§4/§6) into structured lines.
 * @param shape - `hermes-errors` (`TS LEVEL logger: msg`) or `pipe` (`TS | module | trace | LEVEL | {json}`); `mixed` accepts both.
 * @param lines - raw lines of one tail read.
 * @returns parsed lines; unrelated lines (stack traces, blanks) are skipped.
 */
export function parseLogLines(shape: 'hermes-errors' | 'pipe' | 'mixed', lines: readonly string[]): ParsedLogLine[] {
  const out: ParsedLogLine[] = []
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '')
    if (line.trim() === '') continue
    if (shape !== 'pipe') {
      const match = HERMES_LINE_RE.exec(line)
      if (match !== null) {
        const [, datePart, timePart, levelWord, logger, message] = match
        out.push({ occurredAt: isoAt(datePart!, timePart!), level: LEVELS[levelWord!] ?? 'info', logger: logger!.trim(), message: message!.trim() })
        continue
      }
    }
    if (shape !== 'hermes-errors') {
      const match = PIPE_LINE_RE.exec(line)
      if (match !== null) {
        const [, datePart, timePart, module, , levelWord, body] = match
        out.push({ occurredAt: isoAt(datePart!, timePart!), level: LEVELS[levelWord!] ?? 'info', logger: module!.trim(), message: bodyOf(body!) })
      }
    }
  }
  return out
}

/** The `message` field of a JSON body, falling back to the raw body. */
function bodyOf(body: string): string {
  const text = body.trim()
  if (!text.startsWith('{')) return text
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null && 'message' in parsed) {
      const message = (parsed as { message?: unknown }).message
      if (typeof message === 'string') return message
    }
  } catch {
    // keep the raw body when it is not valid JSON
  }
  return text
}
