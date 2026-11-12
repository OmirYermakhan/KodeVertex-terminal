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
  /** Вторичное приглашение (PS2, `A;k=s`): команда не закончена, ZLE ждёт продолжения. */
  | { t: 'continue' }
  | { t: 'start'; command: string }
  | { t: 'end'; exitCode: number }

/** Замороженный блок длиннее этого числа строк сворачивается. */
export const COLLAPSE_LINES = 2000

/** Полезная нагрузка OSC 133 (после "133;"): 'A' | 'A;k=s' | 'C;<base64>' | 'D;<код>'. */
export function parseOsc133(data: string): ParsedOsc133 | null {
  if (data === 'A') return { t: 'prompt' }
  if (data.startsWith('A;')) {
    const params = data.slice(2).split(';')
    if (!params.every((x) => /^[\w-]+=/.test(x))) return null
    return params.includes('k=s') ? { t: 'continue' } : { t: 'prompt' }
  }
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

/** Монотонный счётчик id блоков: после очистки ленты (⌃L) id не повторяются. */
let blockSeq = 0

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
    id: `sh-${++blockSeq}`,
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

/** Управляющие символы, кроме \t и \n (включая ESC и C1): в ZLE они стали бы нажатиями клавиш. */
const UNSAFE_CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g

/**
 * Байты команды для ZLE: без управляющих символов, всегда через bracketed paste — табуляция и переводы
 * строк остаются литералами (без дополнения и разбиения на команды), затем ↵.
 */
export function commandBytes(cmd: string): string {
  return `\x1b[200~${cmd.replace(UNSAFE_CONTROLS, '')}\x1b[201~\r`
}

/** id Claude-элемента ленты по его индексу в ClaudeState.items панели (индексы только растут). */
export const claudeItemId = (i: number) => `cl-${i}`

/**
 * Перенос изменений ClaudeState.items в ленту: изменённые элементы заменяются на месте,
 * новые добавляются в конец (после уже идущих shell-блоков — хронологически).
 * Элементы с индексом < from (лента очищена ⌃L) не показываются.
 */
export function syncClaude(
  items: FeedItem[],
  prev: readonly FeedClaudeItem[],
  next: readonly FeedClaudeItem[],
  from = 0,
): FeedItem[] {
  if (prev === next) return items
  let out: FeedItem[] | null = null
  for (let i = from; i < next.length; i++) {
    if (i < prev.length && prev[i] === next[i]) continue
    out ??= items.slice()
    const id = claudeItemId(i)
    const entry: ClaudeItem = { kind: 'claude', id, item: next[i] }
    let at = -1
    if (i < prev.length) {
      for (let j = out.length - 1; j >= 0; j--) {
        if (out[j].id === id) {
          at = j
          break
        }
      }
    }
    if (at >= 0) out[at] = entry
    else out.push(entry)
  }
  return out ?? items
}

export function formatDuration(ms: number): string {
  if (ms < 59950) return `${(Math.round(ms / 100) / 10).toFixed(1)} с`
  const total = Math.round(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}м ${String(s).padStart(2, '0')}с`
}

/** Сколько строк показывает свёрнутый длинный блок. */
export const COLLAPSED_ROWS = 200

export type SelectionMove = { id: string | null; leave: boolean }

/**
 * ⌘↑/⌘↓ по завершённым shell-блокам. Без выбора ⌘↑ берёт последний блок.
 * ⌘↓ с последнего блока снимает выбор и сообщает leave — дальше фокус уходит из ленты
 * (в панель агентов, Task 8).
 */
export function moveSelection(items: FeedItem[], selected: string | null, dir: 'up' | 'down'): SelectionMove {
  const ids = items.filter((it): it is ShellBlock => it.kind === 'shell' && !it.running).map((b) => b.id)
  const i = selected === null ? -1 : ids.indexOf(selected)
  if (dir === 'up') {
    if (ids.length === 0) return { id: null, leave: false }
    return { id: i < 0 ? ids[ids.length - 1] : ids[Math.max(0, i - 1)], leave: false }
  }
  if (i < 0) return { id: null, leave: selected === null }
  if (i === ids.length - 1) return { id: null, leave: true }
  return { id: ids[i + 1], leave: false }
}
