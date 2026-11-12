// История команд строки ввода: из файла истории zsh (shell_history) + выполненные в приложении.
import { invoke } from '@tauri-apps/api/core'

export const HISTORY_LIMIT = 5000

let entries: string[] = []
let loading: Promise<void> | null = null

/** Повторы подряд схлопываются: ↑ не стоит на одной команде несколько раз. */
function dedupe(list: readonly string[]): string[] {
  const out: string[] = []
  for (const c of list) if (c.trim() && out[out.length - 1] !== c) out.push(c)
  return out
}

/** Загрузить историю zsh один раз на приложение; команды, выполненные до загрузки, остаются последними. */
export function loadHistory(): Promise<void> {
  loading ??= Promise.resolve()
    .then(() => invoke<string[]>('shell_history'))
    .then((file) => {
      entries = dedupe([...(Array.isArray(file) ? file : []), ...entries]).slice(-HISTORY_LIMIT)
    })
    .catch(() => {})
  return loading
}

/** Команды, старые первыми. */
export function getHistory(): readonly string[] {
  return entries
}

export function pushHistory(cmd: string): void {
  if (!cmd.trim() || entries[entries.length - 1] === cmd) return
  entries = [...entries, cmd].slice(-HISTORY_LIMIT)
}

/** Только для тестов. */
export function resetHistory(list: string[] = []): void {
  entries = dedupe(list)
  loading = null
}

/** Позиция в истории: index — элемент entries, null — набираемая строка (draft). */
export interface HistoryNav {
  index: number | null
  draft: string
}

export const NAV_START: HistoryNav = { index: null, draft: '' }

/**
 * Шаг по истории. ↑ с набираемой строки запоминает её как draft; ↓ с последней записи
 * возвращает draft. null — двигаться некуда.
 */
export function historyStep(
  list: readonly string[],
  nav: HistoryNav,
  current: string,
  dir: 'up' | 'down',
): { nav: HistoryNav; value: string } | null {
  if (dir === 'up') {
    if (nav.index === null) {
      if (list.length === 0) return null
      const index = list.length - 1
      return { nav: { index, draft: current }, value: list[index] }
    }
    if (nav.index <= 0) return null
    const index = Math.min(nav.index, list.length) - 1
    return { nav: { ...nav, index }, value: list[index] }
  }
  if (nav.index === null) return null
  const index = nav.index + 1
  if (index >= list.length) return { nav: { index: null, draft: '' }, value: nav.draft }
  return { nav: { ...nav, index }, value: list[index] }
}
