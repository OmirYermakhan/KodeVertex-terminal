import type { FeedClaudeItem } from '../claude/reducer'

export type ShellBlock = {
  kind: 'shell'
  id: string
  command: string
  cwd: string
  startedAt: number
  durationMs: number | null
  exitCode: number | null
  html: string | null
  lines: number
  running: boolean
}
export type ClaudeItem = { kind: 'claude'; id: string; item: FeedClaudeItem }
export type FeedItem = ShellBlock | ClaudeItem

export type ShellEvent =
  | { t: 'prompt' }
  | { t: 'start'; command: string; cwd: string; at: number }
  | { t: 'end'; exitCode: number; at: number; html: string; lines: number }

/** Результат разбора OSC 133 — без времени, cwd и HTML. */
export type ParsedOsc133 =
  | { t: 'prompt' }
  | { t: 'start'; command: string }
  | { t: 'end'; exitCode: number }

/** Замороженный блок длиннее этого числа строк сворачивается. */
export const COLLAPSE_LINES = 2000

/** Полезная нагрузка OSC 133 (после "133;"): 'A' | 'C;<base64>' | 'D;<код>'. */
export function parseOsc133(data: string): ParsedOsc133 | null {
  if (data === 'A') return { t: 'prompt' }
  if (data.startsWith('C;')) {
    try {
      const bin = atob(data.slice(2))
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
      return { t: 'start', command: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
    } catch {
      return null
    }
  }
  if (data.startsWith('D;')) {
    const code = data.slice(2)
    if (!/^-?\d+$/.test(code)) return null
    return { t: 'end', exitCode: Number(code) }
  }
  return null
}

function runningIndex(items: FeedItem[]): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (it.kind === 'shell' && it.running) return i
  }
  return -1
}

export function applyShell(items: FeedItem[], ev: ShellEvent): FeedItem[] {
  if (ev.t === 'prompt') return items
  const idx = runningIndex(items)
  if (ev.t === 'end') {
    if (idx < 0) return items
    const cur = items[idx] as ShellBlock
    const next = items.slice()
    next[idx] = {
      ...cur,
      running: false,
      exitCode: ev.exitCode,
      durationMs: Math.max(0, ev.at - cur.startedAt),
      html: ev.html,
      lines: ev.lines,
    }
    return next
  }
  const next = items.slice()
  if (idx >= 0) {
    const cur = items[idx] as ShellBlock
    next[idx] = { ...cur, running: false, exitCode: null, durationMs: Math.max(0, ev.at - cur.startedAt) }
  }
  next.push({
    kind: 'shell',
    id: `sh-${items.length}-${ev.at}`,
    command: ev.command,
    cwd: ev.cwd,
    startedAt: ev.at,
    durationMs: null,
    exitCode: null,
    html: null,
    lines: 0,
    running: true,
  })
  return next
}

export function formatDuration(ms: number): string {
  if (ms < 59950) return `${(Math.round(ms / 100) / 10).toFixed(1)} с`
  const total = Math.round(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}м ${String(s).padStart(2, '0')}с`
}
