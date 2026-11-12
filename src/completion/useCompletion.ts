// Состояние попапа подсказок путей: строка ввода → список из Rust → выбор и подстановка в поле.
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import {
  AT_COMMAND,
  applyCompletion,
  atContext,
  completeLine,
  completionContext,
  rankEntries,
  resolveDir,
  type CompletionContext,
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
  /** Выбор менялся ↑/↓ с момента показа списка. */
  navigated: boolean
  /** Строка ввода целиком и границы строки курсора в ней (ctx — по этой строке). */
  buffer: string
  lineStart: number
  lineEnd: number
}

export interface CompletionOptions {
  cwd: () => string | undefined
  home: string | null
  /** Подстановка: новое значение поля и курсор (UTF-16); run — сразу выполнить строку. */
  replace: (value: string, cursor: number, run: boolean) => void
  /** 'at' — режим Claude: подсказки только для `@путь`, выбор вставляет значок (insert). */
  mode?: () => 'shell' | 'at'
  /** `@путь` выбран: значок вместо [from, to) строки ввода (UTF-16). */
  insert?: (path: string, isDir: boolean, from: number, to: number) => void
}

/** Достаточно для KeyboardEvent и React-события клавиатуры. */
export type KeyLike = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'> & {
  isComposing?: boolean
  keyCode?: number
  type?: string
}

export interface CompletionApi {
  state: CompletionState
  /**
   * Строка ввода изменилась (или курсор). typed=false — значение подставлено не набором
   * (история): попап не открывается.
   */
  update(buffer: string, cursor: number, typed?: boolean): void
  /** Строку отправили — каталог мог измениться, кэш и esc сбрасываются. */
  reset(): void
  /** true — клавиша съедена попапом и не должна дойти до поля. */
  onKey(e: KeyLike): boolean
  /** Подставить элемент i (как Tab). */
  pick(i: number): void
  /** `@путь`: вставить значок элемента i (и папки — как ↵, а не заход в неё). */
  insertAt(i: number): void
  close(): void
}

const LIST_DEBOUNCE_MS = 30
const PREVIEW_DEBOUNCE_MS = 80
/** Длиннее — не разбираем (вставка больших текстов). */
const MAX_BUFFER = 4096

const CLOSED: CompletionState = {
  open: false,
  items: [],
  selected: 0,
  ctx: null,
  preview: null,
  dir: '',
  navigated: false,
  buffer: '',
  lineStart: 0,
  lineEnd: 0,
}

export const joinPath = (dir: string, name: string) => (dir.endsWith('/') ? dir : dir + '/') + name

/**
 * Что сделает ↵ при открытом попапе: 'go' — подставить и выполнить (cd), 'substitute' — только
 * подставить, null — попап закроется, а строка выполнится как набрана. По этому же значению
 * строится подсказка попапа, так что она всегда совпадает с поведением.
 */
export function enterAction(s: CompletionState): 'go' | 'substitute' | 'insert' | null {
  const ctx = s.ctx
  const item = s.items[s.selected]
  if (!s.open || !ctx || !item) return null
  // `@путь`: ↵ всегда вставляет значок выбранного.
  if (ctx.command === AT_COMMAND) return 'insert'
  const repl = applyCompletion(ctx, item)
  // Токен уже равен элементу — подставлять нечего.
  if (ctx.token === repl || ctx.token + '/' === repl || ctx.token === repl + '/') return null
  if (ctx.command === 'cd') return s.navigated || ctx.namePart !== '' ? 'go' : null
  return s.navigated ? 'substitute' : null
}

export function useCompletion(o: CompletionOptions): CompletionApi {
  const [state, setState] = useState<CompletionState>(CLOSED)
  const [api] = useState(() => createController(o, setState))
  useEffect(() => {
    api.setOptions(o)
  })
  useEffect(() => api.dispose, [api])
  return { state, update: api.update, reset: api.reset, onKey: api.onKey, pick: api.pick, insertAt: api.insertAt, close: api.close }
}

function createController(initial: CompletionOptions, publish: (s: CompletionState) => void) {
  let options = initial
  let cur = CLOSED
  let listTimer: ReturnType<typeof setTimeout> | undefined
  let previewTimer: ReturnType<typeof setTimeout> | undefined
  // Счётчики запросов: ответ на устаревший запрос отбрасывается.
  let listSeq = 0
  let previewSeq = 0
  let cache: { key: string; entries: FsEntryTS[] } | null = null
  /** Последняя обработанная строка (`курсор;буфер`): повтор (onSelect после onChange) не пересчитываем. */
  let lastLine: string | null = null
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

  type Line = Pick<CompletionState, 'buffer' | 'lineStart' | 'lineEnd'>

  const show = (ctx: CompletionContext, dir: string, entries: FsEntryTS[], line: Line) => {
    const items = rankEntries(ctx.namePart, entries)
    if (items.length === 0) return close()
    set({ open: true, items, selected: 0, ctx, preview: null, dir, navigated: false, ...line })
    schedulePreview()
  }

  const update = (buffer: string, cursor: number, typed = true) => {
    const key = `${cursor};${buffer}`
    if (key === lastLine) return
    lastLine = key
    if (!typed || buffer.length > MAX_BUFFER) return close()
    if (dismissedLine !== null) {
      if (key === dismissedLine) return
      dismissedLine = null
    }
    // Многострочная строка ввода: контекст — по строке, где курсор.
    const lineStart = buffer.lastIndexOf('\n', cursor - 1) + 1
    const nl = buffer.indexOf('\n', cursor)
    const lineEnd = nl < 0 ? buffer.length : nl
    const text = buffer.slice(lineStart, lineEnd)
    const at = options.mode?.() === 'at'
    const ctx = (at ? atContext : completionContext)(text, [...buffer.slice(lineStart, cursor)].length)
    const { cwd: getCwd, home } = options
    const cwd = getCwd()
    if (!ctx || !cwd || (ctx.dirPart.startsWith('~') && !home)) return close()
    const dir = resolveDir(ctx.dirPart, cwd, home ?? '')
    const cacheKey = `${dir}\0${ctx.dirsOnly}\0${ctx.includeHidden}`
    const line = { buffer, lineStart, lineEnd }

    stopPending()
    if (cache?.key === cacheKey) return show(ctx, dir, cache.entries, line)
    // Пока список не пришёл, старый ctx неверен — попап закрыт.
    if (cur !== CLOSED) set(CLOSED)
    const seq = listSeq
    listTimer = setTimeout(() => {
      invoke<FsEntryTS[]>('fs_list', { dir, dirsOnly: ctx.dirsOnly, includeHidden: ctx.includeHidden })
        .then((entries) => {
          if (seq !== listSeq) return
          cache = { key: cacheKey, entries }
          show(ctx, dir, entries, line)
        })
        .catch(() => {
          if (seq === listSeq) close()
        })
    }, LIST_DEBOUNCE_MS)
  }

  const reset = () => {
    cache = null
    lastLine = null
    dismissedLine = null
    close()
  }

  const apply = (i: number, run: boolean, insert = false) => {
    const item = cur.items[i]
    const { ctx, buffer, lineStart, lineEnd } = cur
    if (!cur.open || !item || !ctx) return
    // `@путь`: файл (или папка по ↵) — значком; папка по Tab — заходим в неё.
    if (ctx.command === AT_COMMAND && (insert || !item.isDir) && options.insert) {
      const from = lineStart + ctx.tokenStart
      const path = joinPath(cur.dir, item.name)
      close()
      options.insert(path, item.isDir, from, from + ctx.token.length)
      return
    }
    let { value, cursor } = completeLine(buffer.slice(lineStart, lineEnd), ctx, item)
    // ↵ на cd: каталог без завершающего слэша, строка сразу выполняется.
    if (run && value.slice(0, cursor).endsWith('/')) {
      value = value.slice(0, cursor - 1) + value.slice(cursor)
      cursor--
    }
    const full = buffer.slice(0, lineStart) + value + buffer.slice(lineEnd)
    close()
    options.replace(full, lineStart + cursor, run)
  }

  const select = (i: number) => {
    set({ ...cur, selected: i, navigated: true })
    schedulePreview()
  }

  const onKey = (e: KeyLike): boolean => {
    // IME-набор: клавиши принадлежат композиции, а не попапу.
    if (e.isComposing || e.keyCode === 229) return false
    if (e.type !== undefined && e.type !== 'keydown') return false
    if (!cur.open) return false
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
      case 'Enter': {
        const action = enterAction(cur)
        if (action === null) {
          close()
          return false
        }
        apply(cur.selected, action === 'go', action === 'insert')
        return true
      }
      case 'Escape':
        dismissedLine = lastLine
        close()
        return true
      default:
        return false
    }
  }

  return {
    update,
    reset,
    onKey,
    close,
    pick: (i: number) => apply(i, false),
    insertAt: (i: number) => apply(i, false, true),
    dispose: stopPending,
    setOptions: (o: CompletionOptions) => void (options = o),
  }
}
