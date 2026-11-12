// Карточка выбора модели (`/model` в режиме Claude) над строкой ввода: рамка и строки — как у выборки
// `claude …` / `/…` (.cp.hp), номера 1–5, ✓ у текущей модели, ниже — усилие ←/→.
import { DEFAULT_EFFORT, EFFORTS, MODEL_ROWS, type PickerState } from './models'

export const PICKER_TITLE = 'Выбор модели'
export const PICKER_DESC = 'Модель для новых сессий; s — только для этой сессии'
export const PICKER_KEYS = '↵ сделать по умолчанию · s только эта сессия · esc отмена'

export interface ModelPickerProps {
  state: PickerState
  /** Псевдоним текущей модели панели (`default`, `opus`, …). */
  current: string
  onSelect(i: number): void
}

export function ModelPicker({ state, current, onSelect }: ModelPickerProps) {
  return (
    <div className="cp hp mp" role="dialog" aria-label={PICKER_TITLE}>
      <div className="hp-h">{PICKER_TITLE}</div>
      <div className="mp-desc">{PICKER_DESC}</div>
      <div className="hp-list" role="listbox">
        {MODEL_ROWS.map((r, i) => (
          <div
            key={r.alias}
            role="option"
            aria-selected={i === state.selected}
            className={'hp-row mp-row' + (i === state.selected ? ' sel' : '') + (r.alias === 'fable' ? ' fable' : '')}
            // mousedown, а не click: фокус остаётся в строке ввода.
            onMouseDown={(e) => {
              e.preventDefault()
              onSelect(i)
            }}
          >
            <span className="hp-g">{i + 1}.</span>
            <span className="hp-n">{r.label}</span>
            <span className="hp-d">{r.description}</span>
            <span className="mp-ok">{r.alias === current ? '✓' : ''}</span>
          </div>
        ))}
      </div>
      <div className="mp-effort">
        ◐ Усилие: <b>{EFFORTS[state.effort]}</b>
        {/* «(по умолчанию)» — только когда применённое усилие и есть уровень по умолчанию. */}
        {!state.effortTouched && EFFORTS[state.effort] === DEFAULT_EFFORT ? ' (по умолчанию)' : ''} ←/→
      </div>
      <div className="hp-keys">{PICKER_KEYS}</div>
    </div>
  )
}

export default ModelPicker
