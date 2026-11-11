// Состояние попапа подсказок путей: отчёты строки zsh → список из Rust → выбор и подстановка.
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import {
  applyCompletion,
  completionContext,
  rankEntries,
  resolveDir,
  type CompletionContext,
  type ZleReport,
} from './completion'

export interface FsEntryTS {
  name: string
  isDir: boolean
  isSymlink: boolean
}

export type FsPreviewTS =
  | { kind: 'dir'; entries: FsEntryTS[]; total: number }
  | { kind: 'text'; lines: string[]; truncated: boolean }
  | { kind: 'binary'; size: number }
  | { kind: 'error'; message: string }

export interface CompletionState {
  open: boolean
  items: FsEntryTS[]
  selected: number
  ctx: CompletionContext | null
  preview: FsPreviewTS | null
  /** Абсолютный каталог, из которого взяты items. */
  dir: string
}

export interface CompletionOptions {
  cwd: () => string | undefined
  home: string | null
  write: (s: string) => void
}

export interface CompletionApi {
  state: CompletionState
  onReport(r: ZleReport): void
  /** true — клавиша съедена попапом и не должна уйти в терминал. */
  onKey(e: KeyboardEvent): boolean
  /** Подставить элемент i (как Tab). */
  pick(i: number): void
  close(): void
}

const LIST_DEBOUNCE_MS = 30
const PREVIEW_DEBOUNCE_MS = 80

const CLOSED: CompletionState = { open: false, items: [], selected: 0, ctx: null, preview: null, dir: '' }

export const joinPath = (dir: string, name: string) => (dir.endsWith('/') ? dir : dir + '/') + name

export function useCompletion(o: CompletionOptions): CompletionApi {
  const [state, setState] = useState<CompletionState>(CLOSED)
  const [api] = useState(() => createController(o, setState))
  useEffect(() => {
    api.setOptions(o)
  })
  useEffect(() => api.dispose, [api])
  return { state, onReport: api.onReport, onKey: api.onKey, pick: api.pick, close: api.close }
}

function createController(initial: CompletionOptions, publish: (s: CompletionState) => void) {
  let options = initial
  const opts = () => options
  let cur = CLOSED
  let listTimer: ReturnType<typeof setTimeout> | undefined
  let previewTimer: ReturnType<typeof setTimeout> | undefined
  // Счётчики запросов: ответ на устаревший запрос отбрасывается.
  let listSeq = 0
  let previewSeq = 0
  let cache: { key: string; entries: FsEntryTS[] } | null = null
  let lastLine = ''
  /** Строка, на которой попап закрыли по esc: до её изменения не открываем. */
  let dismissedLine: string | null = null

  const set = (s: CompletionState) => {
    cur = s
    publish(s)
  }

  const stopPending = () => {
    clearTimeout(listTimer)
    clearTimeout(previewTimer)
    listSeq++
    previewSeq++
  }

  const close = () => {
    stopPending()
    if (cur !== CLOSED) set(CLOSED)
  }

  const schedulePreview = () => {
    clearTimeout(previewTimer)
    const seq = ++previewSeq
    const item = cur.items[cur.selected]
    if (!cur.open || !item) return
    const path = joinPath(cur.dir, item.name)
    previewTimer = setTimeout(() => {
      invoke<FsPreviewTS>('fs_preview', { path })
        .catch((e: unknown): FsPreviewTS => ({ kind: 'error', message: String(e) }))
        .then((preview) => {
          if (seq === previewSeq && cur.open) set({ ...cur, preview })
        })
    }, PREVIEW_DEBOUNCE_MS)
  }

  const show = (ctx: CompletionContext, dir: string, entries: FsEntryTS[]) => {
    const items = rankEntries(ctx.namePart, entries)
    if (items.length === 0) return close()
    set({ open: true, items, selected: 0, ctx, preview: null, dir })
    schedulePreview()
  }

  const onReport = (r: ZleReport) => {
    if (r === 'end') {
      // Новая строка — каталог мог измениться, кэш больше не нужен.
      cache = null
      lastLine = ''
      dismissedLine = null
      return close()
    }
    lastLine = `${r.cursor};${r.buffer}`
    if (dismissedLine !== null) {
      if (lastLine === dismissedLine) return
      dismissedLine = null
    }
    const ctx = completionContext(r.buffer, r.cursor)
    const { cwd: getCwd, home } = opts()
    const cwd = getCwd()
    if (!ctx || !cwd || (ctx.dirPart.startsWith('~') && !home)) return close()
    const dir = resolveDir(ctx.dirPart, cwd, home ?? '')
    const key = `${dir}\0${ctx.dirsOnly}\0${ctx.includeHidden}`

    stopPending()
    if (cache?.key === key) return show(ctx, dir, cache.entries)
    // Пока список не пришёл, старый ctx неверен — попап закрыт, клавиши идут в zsh.
    if (cur !== CLOSED) set(CLOSED)
    const seq = listSeq
    listTimer = setTimeout(() => {
      invoke<FsEntryTS[]>('fs_list', { dir, dirsOnly: ctx.dirsOnly, includeHidden: ctx.includeHidden })
        .then((entries) => {
          if (seq !== listSeq) return
          cache = { key, entries }
          show(ctx, dir, entries)
        })
        .catch(() => {
          if (seq === listSeq) close()
        })
    }, LIST_DEBOUNCE_MS)
  }

  const apply = (i: number, enter: boolean) => {
    const item = cur.items[i]
    const ctx = cur.ctx
    if (!cur.open || !item || !ctx) return
    let out = applyCompletion(ctx, item)
    if (enter && ctx.command === 'cd') out = (out.endsWith('/') ? out.slice(0, -1) : out) + '\r'
    // Закрываем до следующего отчёта: ctx уже не соответствует строке.
    close()
    opts().write(out)
  }

  const select = (i: number) => {
    set({ ...cur, selected: i })
    schedulePreview()
  }

  const onKey = (e: KeyboardEvent): boolean => {
    if (!cur.open || e.type !== 'keydown') return false
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false
    const n = cur.items.length
    switch (e.key) {
      case 'ArrowDown':
        select((cur.selected + 1) % n)
        return true
      case 'ArrowUp':
        select((cur.selected - 1 + n) % n)
        return true
      case 'Tab':
      case 'ArrowRight':
        apply(cur.selected, false)
        return true
      case 'Enter':
        apply(cur.selected, true)
        return true
      case 'Escape':
        dismissedLine = lastLine
        close()
        return true
      default:
        return false
    }
  }

  return { onReport, onKey, close, pick: (i: number) => apply(i, false), dispose: stopPending, setOptions: (o: CompletionOptions) => void (options = o) }
}
