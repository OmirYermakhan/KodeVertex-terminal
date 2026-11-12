// Состояние попапа-выборки `claude …` / `/…`: строка ввода → строки → выбор и подстановка.
// Клавиши — те же, что у подсказок путей (↑↓, Tab/→, ↵ только после явного выбора, esc).
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import {
  applyHint,
  BUILTIN_SLASH,
  CLAUDE_OPTIONS,
  customSlashItems,
  hintContext,
  hintQuery,
  rankHints,
  type HintContext,
  type HintItem,
  type HintRow,
  type SlashCommandTS,
} from './claudeHints'
import type { KeyLike } from './useCompletion'

export interface HintsState {
  open: boolean
  ctx: HintContext | null
  rows: HintRow[]
  /** -1 — ничего не выбрано (весь список показан без набора). */
  selected: number
  /** Строка выбрана: ↑/↓ или набран запрос (тогда выбрана первая). */
  navigated: boolean
  buffer: string
}

export interface HintsOptions {
  mode: () => 'shell' | 'claude'
  cwd: () => string | undefined
  /** Подстановка: новое значение поля и курсор; run — сразу выполнить/отправить. */
  replace: (value: string, cursor: number, run: boolean) => void
}

export interface HintsApi {
  state: HintsState
  update(buffer: string, cursor: number, typed?: boolean): void
  reset(): void
  onKey(e: KeyLike): boolean
  pick(i: number): void
  close(): void
}

const CLOSED: HintsState = { open: false, ctx: null, rows: [], selected: -1, navigated: false, buffer: '' }

/**
 * Что сделает ↵ при открытом попапе: 'run' — подставить выбранное и выполнить (выбрано ↑↓ или
 * набран запрос — тогда первая строка); null — попап закроется, строка выполнится как набрана. Подсказка попапа строится по этому же значению.
 */
export function hintEnterAction(s: HintsState): 'run' | null {
  return s.open && s.navigated && s.rows[s.selected] ? 'run' : null
}

/** Что сделает Tab: 'substitute' — подставить выбранное; 'select' — выбрать первую строку. */
export function hintTabAction(s: HintsState): 'substitute' | 'select' | null {
  if (!s.open || s.rows.length === 0) return null
  const row = s.rows[s.selected]
  if (!row) return 'select'
  return row.item.enter ? null : 'substitute'
}

export function useHints(o: HintsOptions): HintsApi {
  const [state, setState] = useState<HintsState>(CLOSED)
  const [api] = useState(() => createHints(o, setState))
  useEffect(() => {
    api.setOptions(o)
  })
  return { state, update: api.update, reset: api.reset, onKey: api.onKey, pick: api.pick, close: api.close }
}

export function createHints(initial: HintsOptions, publish: (s: HintsState) => void) {
  let options = initial
  let cur = CLOSED
  let lastLine: string | null = null
  let dismissedLine: string | null = null
  /** Пользовательские slash-команды по каталогу; null — ещё не загружены. */
  let custom: { cwd: string; items: HintItem[] } | null = null
  let loading: string | null = null

  const set = (s: HintsState) => {
    cur = s
    publish(s)
  }
  const close = () => {
    if (cur !== CLOSED) set(CLOSED)
  }

  const itemsFor = (ctx: HintContext): HintItem[] => {
    if (ctx.kind === 'claude') return CLAUDE_OPTIONS
    const cwd = options.cwd()
    if (cwd && custom?.cwd !== cwd && loading !== cwd) {
      loading = cwd
      invoke<SlashCommandTS[]>('claude_slash_commands', { cwd })
        .catch(() => [] as SlashCommandTS[])
        .then((cmds) => {
          if (loading !== cwd) return
          loading = null
          custom = { cwd, items: customSlashItems(Array.isArray(cmds) ? cmds : []) }
          // Пришли команды — пересчитать открытый (или закрытый из-за отсутствия совпадений) список.
          const line = lastLine
          lastLine = null
          if (line !== null) {
            const i = line.indexOf(';')
            update(line.slice(i + 1), Number(line.slice(0, i)))
          }
        })
    }
    return custom && custom.cwd === cwd ? [...BUILTIN_SLASH, ...custom.items] : BUILTIN_SLASH
  }

  const update = (buffer: string, cursor: number, typed = true) => {
    const key = `${cursor};${buffer}`
    if (key === lastLine) return
    lastLine = key
    if (!typed) return close()
    if (dismissedLine !== null) {
      if (key === dismissedLine) return
      dismissedLine = null
    }
    const ctx = hintContext(buffer, cursor, options.mode())
    if (!ctx) return close()
    const rows = rankHints(ctx, itemsFor(ctx))
    if (rows.length === 0) return close()
    // Весь список без набора — ничего не выбрано; с набором лучшее совпадение выбрано (↵ выполняет его).
    const typedQuery = hintQuery(ctx) !== ''
    // Тот же запрос (пришли команды) — выбор сохраняется, если строка осталась.
    if (cur.open && cur.ctx && cur.buffer === buffer && cur.navigated) {
      const keep = rows.findIndex((r) => r.item === cur.rows[cur.selected]?.item)
      if (keep >= 0) return set({ open: true, ctx, rows, selected: keep, navigated: true, buffer })
    }
    set({ open: true, ctx, rows, selected: typedQuery ? 0 : -1, navigated: typedQuery, buffer })
  }

  const reset = () => {
    lastLine = null
    dismissedLine = null
    custom = null
    loading = null
    close()
  }

  const apply = (i: number, run: boolean) => {
    const row = cur.rows[i]
    const { ctx, buffer } = cur
    if (!cur.open || !row || !ctx) return
    const { value, cursor } = applyHint(buffer, ctx, row)
    close()
    // Подставили без выполнения — попап по новой строке не открывать (там уже следующий аргумент).
    options.replace(run ? value.trimEnd() : value, run ? value.trimEnd().length : cursor, run)
  }

  const select = (i: number) => set({ ...cur, selected: i, navigated: true })

  const onKey = (e: KeyLike): boolean => {
    if (e.isComposing || e.keyCode === 229) return false
    if (e.type !== undefined && e.type !== 'keydown') return false
    if (!cur.open) return false
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false
    const n = cur.rows.length
    switch (e.key) {
      case 'ArrowDown':
        select(cur.selected < 0 ? 0 : (cur.selected + 1) % n)
        return true
      case 'ArrowUp':
        select(cur.selected < 0 ? n - 1 : (cur.selected - 1 + n) % n)
        return true
      case 'Tab':
      case 'ArrowRight': {
        const t = hintTabAction(cur)
        // → только подставляет; без выбора — обычное движение курсора.
        if (t === 'substitute') apply(cur.selected, false)
        else if (e.key === 'ArrowRight') return false
        else if (t === 'select') select(0)
        return true
      }
      case 'Enter':
        if (hintEnterAction(cur) === null) {
          close()
          return false
        }
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

  return {
    update,
    reset,
    onKey,
    close,
    pick: (i: number) => {
      // Мышь: строка «открыть режим» выполняется, остальные — подставляются.
      const row = cur.rows[i]
      if (row?.item.enter) apply(i, true)
      else apply(i, false)
    },
    setOptions: (o: HintsOptions) => void (options = o),
  }
}
