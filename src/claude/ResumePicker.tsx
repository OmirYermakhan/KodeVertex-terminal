// Карточка выбора разговора (`/resume` в режиме Claude) над строкой ввода: рамка и строки — как
// у выбора модели (.cp.hp.mp), номера 1–9, ✓ у текущего разговора, пояснение — когда и сколько.
import { useEffect, useRef } from 'react'
import { sessionDetail, type ResumeState } from './resume'

export const RESUME_TITLE = 'Продолжить разговор'
export const RESUME_DESC = 'Прошлые разговоры Claude Code в этом каталоге'
export const RESUME_KEYS = '↵ продолжить · ↑↓ выбрать · esc отмена'
export const RESUME_LOADING = 'Загрузка…'
export const RESUME_EMPTY = 'Прошлых разговоров в этом каталоге нет'

export interface ResumePickerProps {
  state: ResumeState
  /** id разговора панели (✓); null — нет. */
  current: string | null
  /** Сейчас, мс (для «5 мин назад»). */
  now: number
  onSelect(i: number): void
  onPick(i: number): void
}

export function ResumePicker({ state, current, now, onSelect, onPick }: ResumePickerProps) {
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const row = listRef.current?.querySelector('[aria-selected="true"]') as HTMLElement | null
    row?.scrollIntoView?.({ block: 'nearest' })
  }, [state.selected, state.rows])
  const rows = state.rows ?? []
  const empty = state.error ?? (state.rows === null ? RESUME_LOADING : rows.length === 0 ? RESUME_EMPTY : null)
  return (
    <div className="cp hp mp rp" role="dialog" aria-label={RESUME_TITLE}>
      <div className="hp-h">{RESUME_TITLE}</div>
      <div className="mp-desc">{RESUME_DESC}</div>
      <div className="hp-list" role="listbox" ref={listRef}>
        {empty !== null && <div className={'hp-row rp-empty' + (state.error ? ' err' : '')}>{empty}</div>}
        {rows.map((r, i) => (
          <div
            key={r.id}
            role="option"
            aria-selected={i === state.selected}
            className={'hp-row mp-row rp-row' + (i === state.selected ? ' sel' : '')}
            // mousedown, а не click: фокус остаётся в строке ввода. Второй клик по выбранной — продолжить.
            onMouseDown={(e) => {
              e.preventDefault()
              if (i === state.selected) onPick(i)
              else onSelect(i)
            }}
          >
            <span className="hp-g">{i < 9 ? `${i + 1}.` : ''}</span>
            <span className="hp-n">{r.title}</span>
            <span className="hp-d">{sessionDetail(r, now)}</span>
            <span className="mp-ok">{r.id === current ? '✓' : ''}</span>
          </div>
        ))}
      </div>
      <div className="hp-keys">{RESUME_KEYS}</div>
    </div>
  )
}

export default ResumePicker
