import { describe, expect, it } from 'vitest'
import { advance, parseLogLines, type FileMark } from '../packages/agent-cron-dashboard/src/fleet/log-tail.ts'

const mark = (size: number, inode = 'dev-1.ino-42'): FileMark => ({ size, inode })

describe('log tail (P5 rotation + offset cursor)', () => {
  it('first read takes the tail window and sets the offset to the file size', () => {
    const window = 'line-a\nline-b\nline-c\n'
    const result = advance(null, { size: window.length, inode: 'dev-1.ino-42' }, window, 4096)
    expect(result.offset).toBe(window.length)
    expect(result.next).toEqual({ size: window.length, inode: 'dev-1.ino-42' })
    expect(result.rotated).toBe(false)
    expect(result.dropped).toBe(false)
    expect(result.text).toBe(window)
  })

  it('an unchanged inode appends only the bytes after the offset', () => {
    const window = 'line-c\nline-d\n'
    const result = advance(mark(14), { size: 21, inode: 'dev-1.ino-42' }, window, 4096)
    // the previous offset is 14 bytes into the file; the window holds the last 14 bytes
    expect(result.offset).toBe(21)
    expect(result.rotated).toBe(false)
    expect(result.text).toBe('line-d\n')
  })

  it('a changed inode (rotation) rereads the window from the start', () => {
    const window = 'fresh-1\nfresh-2\n'
    const result = advance(mark(40), { size: window.length, inode: 'dev-1.ino-77' }, window, 4096)
    expect(result.rotated).toBe(true)
    expect(result.offset).toBe(window.length)
    expect(result.text).toBe(window)
    expect(result.next.inode).toBe('dev-1.ino-77')
  })

  it('a shrink on the same inode is treated as truncation', () => {
    const window = 'tiny\n'
    const result = advance(mark(500), { size: 5, inode: 'dev-1.ino-42' }, window, 4096)
    expect(result.rotated).toBe(true)
    expect(result.offset).toBe(5)
    expect(result.text).toBe('tiny\n')
  })

  it('an unchanged size yields an empty increment', () => {
    const result = advance(mark(9), { size: 9, inode: 'dev-1.ino-42' }, '', 4096)
    expect(result.offset).toBe(9)
    expect(result.text).toBe('')
    expect(result.dropped).toBe(false)
  })

  it('marks dropped when the unseen gap exceeds the window (never fails the source)', () => {
    const result = advance(mark(100), { size: 100 + 9000, inode: 'dev-1.ino-42' }, 'x'.repeat(512), 512)
    expect(result.dropped).toBe(true)
    expect(result.offset).toBe(100 + 9000)
  })

  it('treats an empty file as an offset of zero', () => {
    const result = advance(null, { size: 0, inode: 'dev-1.ino-42' }, '', 4096)
    expect(result.offset).toBe(0)
    expect(result.text).toBe('')
    expect(result.next.size).toBe(0)
  })
})

describe('log line parsing (both shapes measured in probes)', () => {
  it('parses the hermes shape: TS LEVEL logger[: prefix] message', () => {
    const entries = parseLogLines('hermes-errors', [
      '2026-11-08 22:14:00,525 WARNING agent.tool_executor: Tool skill_manage returned error (0.00s)',
      '2026-11-07 16:03:18,229 ERROR tools.vision_tools: Error analyzing image: Error code: 400',
    ])
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ level: 'warning', logger: 'agent.tool_executor' })
    expect(entries[1]).toMatchObject({ level: 'error', logger: 'tools.vision_tools', occurredAt: '2026-11-07T16:03:18.229+08:00' })
  })

  it('parses the pipe shape: TS | module | trace | LEVEL | {json}', () => {
    const entries = parseLogLines('pipe', [
      '2026-11-06 15:07:35 | tool | default_trace_id | ERROR | {"event_type":"tool_call_error","message":"Todo modify tool invocation failed"}',
    ])
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ level: 'error', logger: 'tool', message: 'Todo modify tool invocation failed' })
  })

  it('keeps the raw JSON body when it cannot be parsed', () => {
    const entries = parseLogLines('pipe', ['2026-11-06 15:07:35 | tool | default_trace_id | ERROR | {"broken":'])
    expect(entries[0]?.message).toBe('{"broken":')
  })

  it('returns nothing for continuation lines and unknown lines', () => {
    const entries = parseLogLines('mixed', ['  at foo (bar.py:12)', 'random noise', ''])
    expect(entries).toEqual([])
  })
})
