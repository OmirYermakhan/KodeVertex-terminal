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
  /** exitCode null — конец без 133;D (например, `exec zsh`: новое приглашение посреди команды). */
  | { t: 'end'; exitCode: number | null; at: number; html: string; lines: number }
  /** Вывод вне пары C…D (ошибка разбора, сообщения о фоновых заданиях): готовый блок. */
  | { t: 'stray'; command: string; cwd: string; at: number; html: string; lines: number }

/** Результат разбора OSC 133 — без времени, cwd и HTML. */
export type ParsedOsc133 =
  | { t: 'prompt' }
  /** Вторичное приглашение (PS2, `A;k=s`): команда не закончена, ZLE ждёт продолжения. */
  | { t: 'continue' }
  | { t: 'start'; command: string }
  | { t: 'end'; exitCode: number }
  /** `I`: ZLE приняла строку (эхо набранного уже выведено). */
  | { t: 'accepted' }

/** Замороженный блок длиннее этого числа строк сворачивается. */
export const COLLAPSE_LINES = 2000

/**
 * Полезная нагрузка OSC 133 (после "133;"): 'A' | 'A;k=s' | 'I' | 'C;<base64>' | 'D;<код>'.
 * Уже без метки сессии: оболочка шлёт `<нагрузка>;kv=<метка>`, её проверяет и снимает `unmark`.
 */
export function parseOsc133(data: string): ParsedOsc133 | null {
  if (data === 'A') return { t: 'prompt' }
  if (data === 'I') return { t: 'accepted' }
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
  if (ev.t === 'stray') {
    return [
      ...items,
      {
        kind: 'shell',
        id: `sh-${++blockSeq}`,
        command: ev.command,
        cwd: ev.cwd,
        startedAt: ev.at,
        durationMs: null,
        exitCode: null,
        html: ev.html,
        lines: ev.lines,
        running: false,
      },
    ]
  }
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
/** Индекс первого незаконченного Claude-элемента (ответ ещё идёт, действие выполняется); иначе длина. */
export function firstUnfinished(items: readonly FeedClaudeItem[]): number {
  const i = items.findIndex((x) => (x.type === 'assistant' && x.streaming) || (x.type === 'action' && x.status === 'running'))
  return i < 0 ? items.length : i
}

/** Обратно: индекс Claude-элемента по id ленты (-1 — не Claude-элемент). */
export const claudeIndex = (id: string) => (id.startsWith('cl-') ? Number(id.slice(3)) : -1)

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

/** Выбирается ⌘↑/⌘↓: завершённый shell-блок или законченный ответ Claude (их можно вложить ⌘L). */
export function selectable(it: FeedItem): boolean {
  if (it.kind === 'shell') return !it.running
  return it.item.type === 'assistant' && !it.item.streaming && it.item.text.trim() !== ''
}

/**
 * ⌘↑/⌘↓ по завершённым shell-блокам и ответам Claude (also — ещё какие элементы выбираются,
 * например сообщения «Вы», которые можно изменить). Без выбора ⌘↑ берёт последний.
 * ⌘↓ с последнего блока снимает выбор и сообщает leave — дальше фокус уходит из ленты
 * (в панель агентов, Task 8).
 */
export function moveSelection(items: FeedItem[], selected: string | null, dir: 'up' | 'down', also?: (it: FeedItem) => boolean): SelectionMove {
  const ids = items.filter((it) => selectable(it) || !!also?.(it)).map((b) => b.id)
  const i = selected === null ? -1 : ids.indexOf(selected)
  if (dir === 'up') {
    if (ids.length === 0) return { id: null, leave: false }
    return { id: i < 0 ? ids[ids.length - 1] : ids[Math.max(0, i - 1)], leave: false }
  }
  if (i < 0) return { id: null, leave: selected === null }
  if (i === ids.length - 1) return { id: null, leave: true }
  return { id: ids[i + 1], leave: false }
}
