// Вид попапа-выборки `claude …` / `/…`: рамка и подсветка совпадений — как у подсказок путей
// (.cp, highlight), строки — как в панели агентов (группы с заголовками, выделение .row.focus).
import { useEffect, useRef, type ReactNode } from 'react'
import { highlight } from './CompletionPopup'
import { GROUP_GLYPHS, GROUP_TITLES, hintQuery, type HintRow } from './claudeHints'
import { hintTabAction, type HintsState } from './useHints'

/** Текст строки: варианты через запятую (`-c, --continue`). */
export function rowLabel(row: HintRow): string {
  return row.item.aliases.join(', ')
}

/** Подсказка клавиш — по hintTabAction, т. е. ровно то, что сделают клавиши. */
export function hintKeys(s: HintsState): string {
  const parts = ['↑↓ выбрать']
  if (hintTabAction(s) === 'substitute') parts.push('⇥ подставить')
  // ↵ всегда выполняет: выбранную после ↑↓ строку (hintEnterAction) или набранное как есть.
  const send = s.ctx?.kind === 'slash' ? 'отправить' : 'выполнить'
  parts.push(`↵ ${send}`, 'esc закрыть')
  return parts.join(' · ')
}

export interface HintsPopupProps {
  state: HintsState
  onPick(i: number): void
}

export function HintsPopup({ state, onPick }: HintsPopupProps) {
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const row = listRef.current?.querySelector('[aria-selected="true"]') as HTMLElement | null
    row?.scrollIntoView?.({ block: 'nearest' })
  }, [state.selected, state.rows])

  if (!state.open || !state.ctx) return null
  const query = hintQuery(state.ctx)
  const slash = state.ctx.kind === 'slash'
  const nameCh = Math.min(32, Math.max(8, ...state.rows.map((r) => rowLabel(r).length)))

  const out: ReactNode[] = []
  let group: string | null = null
  state.rows.forEach((row, i) => {
    if (row.item.group !== group) {
      group = row.item.group
      out.push(
        <div key={'h' + group} className="hp-h" role="presentation">
          {GROUP_TITLES[row.item.group]}
        </div>,
      )
    }
    const label: ReactNode[] = []
    row.item.aliases.forEach((a, k) => {
      if (k > 0) label.push(', ')
      // Совпадение подсвечивается только в варианте, который подставится.
      const q = k === row.alias ? query : ''
      label.push(
        <span key={k}>{slash ? ['/', ...highlight(q, a.slice(1))] : highlight(q, a)}</span>,
      )
    })
    out.push(
      <div
        key={row.item.group + row.item.aliases[0]}
        role="option"
        aria-selected={i === state.selected}
        className={'hp-row' + (i === state.selected ? ' sel' : '')}
        // mousedown, а не click: фокус остаётся в строке ввода.
        onMouseDown={(e) => {
          e.preventDefault()
          onPick(i)
        }}
      >
        <span className="hp-g">{GROUP_GLYPHS[row.item.group]}</span>
        <span className="hp-n">{label}</span>
        <span className="hp-d">{row.item.description}</span>
      </div>,
    )
  })

  return (
    <div className="cp hp" style={{ ['--hp-name' as string]: `${nameCh + 1}ch` }}>
      <div className="hp-list" ref={listRef} role="listbox">
        {out}
      </div>
      <div className="hp-keys">{hintKeys(state)}</div>
    </div>
  )
}

export default HintsPopup
