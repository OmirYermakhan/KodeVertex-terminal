// Поиск ⌃R по истории: рамка и строки — как у выборки `claude …` (.cp.hp), запрос — набранная строка.
import { useEffect, useRef } from 'react'
import { highlight } from '../completion/CompletionPopup'
import { historyKeys } from './historySearch'

export const HISTORY_TITLE = 'История'
export const HISTORY_EMPTY = 'Совпадений нет'

export interface HistoryPickerProps {
  rows: readonly string[]
  selected: number
  query: string
  claude: boolean
  onPick(i: number): void
}

export function HistoryPicker({ rows, selected, query, claude, onPick }: HistoryPickerProps) {
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const row = listRef.current?.querySelector('[aria-selected="true"]') as HTMLElement | null
    row?.scrollIntoView?.({ block: 'nearest' })
  }, [selected, rows])
  return (
    <div className="cp hp hs">
      <div className="hp-list" ref={listRef} role="listbox" aria-label={HISTORY_TITLE}>
        <div className="hp-h" role="presentation">
          {HISTORY_TITLE}
        </div>
        {rows.length === 0 && <div className="hp-row hs-row hs-empty">{HISTORY_EMPTY}</div>}
        {rows.map((r, i) => (
          <div
            key={r}
            role="option"
            aria-selected={i === selected}
            className={'hp-row hs-row' + (i === selected ? ' sel' : '')}
            // mousedown, а не click: фокус остаётся в строке ввода.
            onMouseDown={(e) => {
              e.preventDefault()
              onPick(i)
            }}
          >
            <span className="hp-n">{highlight(query, r)}</span>
          </div>
        ))}
      </div>
      <div className="hp-keys">{historyKeys(claude)}</div>
    </div>
  )
}

export default HistoryPicker
