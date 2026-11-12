// Вид выбора через `@` (макет 06, сцена Е `.pop`): группы, совпадения подсвечены, справа —
// мини-просмотр выбранного пункта (`.pv` 220px без подвала).
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AT_HINT, matchPositions } from '../completion/CompletionPopup'
import { foldForMatch } from '../completion/completion'
import { GROUP_TITLE, rowToken, type AtRow, type Mark } from './atSearch'
import { loadPreview, type PreviewData } from './preview/api'
import { PreviewCard } from './preview/PreviewCard'
import { entryIcon } from './preview/cardLayout'
import { Icon } from './tokenView'

/** Пауза перед загрузкой бокового просмотра (быстрое ↑↓ не читает каждый файл). */
const SIDE_DEBOUNCE_MS = 80

function marked(text: string, m: Mark | null): ReactNode {
  if (!m) return text
  return (
    <>
      {text.slice(0, m[0])}
      <mark>{text.slice(m[0], m[1])}</mark>
      {text.slice(m[1])}
    </>
  )
}

/** Имя файла с подсвеченными (нечётким совпадением) буквами. */
function fileName(query: string, name: string): ReactNode[] {
  const hit = matchPositions(query, name)
  const out: ReactNode[] = []
  let run = ''
  let on = false
  const flush = () => {
    if (run) out.push(on ? <mark key={out.length}>{run}</mark> : run)
    run = ''
  }
  foldForMatch(name).clusters.forEach((c, i) => {
    if (hit.has(i) !== on) {
      flush()
      on = !on
    }
    run += c
  })
  flush()
  return out
}

function Row({ row, query, dirPart }: { row: AtRow; query: string; dirPart: string }) {
  switch (row.group) {
    case 'files': {
      const [icon, cls] = entryIcon(row.entry.name, row.entry.isDir)
      return (
        <>
          <Icon name={icon} className={cls} />
          <span className="tx">
            {fileName(query, row.entry.name)}
            {row.entry.isDir ? '/' : ''}
          </span>
          {dirPart && <span className="d">{dirPart}</span>}
        </>
      )
    }
    case 'blocks': {
      const b = row.block
      const failed = b.exitCode !== null && b.exitCode !== 0
      return (
        <>
          <Icon name="term" className={failed ? 'ico bad' : 'ico ok'} />
          <span className="tx">
            {marked(b.command.replace(/\s+/g, ' ').trim(), row.cmdMark)}
            {row.detail !== null && <span className="dim"> · {marked(row.detail, row.detailMark)}</span>}
          </span>
          {b.exitCode !== null && <span className="d">код {b.exitCode}</span>}
        </>
      )
    }
    case 'messages':
      return (
        <>
          <Icon name="ai" className="ico ai" />
          <span className="tx">
            {row.agent?.name ?? 'Claude'}: «{marked(row.snippet, row.mark)}»
          </span>
        </>
      )
  }
}

export interface AtPickerProps {
  rows: AtRow[]
  selected: number
  /** Набранное после `@` (часть имени) — для подсветки файлов. */
  query: string
  dirPart: string
  /** Абсолютный каталог файлов (для просмотра). */
  dir: string
  onPick(i: number): void
  onSelect(i: number): void
  /** Справа хватает места для просмотра. */
  side?: boolean
  cwd?: string | null
  home?: string
}

export const AtPicker = memo(function AtPicker({ rows, selected, query, dirPart, dir, onPick, onSelect, side = true, cwd, home }: AtPickerProps) {
  const listRef = useRef<HTMLDivElement>(null)
  const row = rows[selected]
  useEffect(() => {
    listRef.current?.querySelector('.it.on')?.scrollIntoView?.({ block: 'nearest' })
  }, [selected, rows])

  const rowKey = row?.key
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const token = useMemo(() => (row ? rowToken(row, dir) : null), [rowKey, dir])
  const [data, setData] = useState<{ id: string; d: PreviewData } | null>(null)
  useEffect(() => {
    if (!token || !side) return
    const t = setTimeout(() => {
      loadPreview(token)?.then((d) => setData({ id: token.id, d }))
    }, SIDE_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [token, side])

  let group: string | null = null
  return (
    <>
      <div className="pop" role="listbox" aria-label="Вложить">
        <div className="pop-list" ref={listRef}>
          {rows.map((r, i) => {
            const head = r.group !== group ? GROUP_TITLE[r.group] : null
            group = r.group
            return (
              <div key={r.key}>
                {head && <div className="gh">{head}</div>}
                <div
                  role="option"
                  aria-selected={i === selected}
                  className={'it' + (i === selected ? ' on' : '')}
                  onMouseDown={(e) => {
                    // mousedown, а не click: фокус остаётся в строке ввода.
                    e.preventDefault()
                    onPick(i)
                  }}
                  onMouseMove={() => i !== selected && onSelect(i)}
                >
                  <Row row={r} query={query} dirPart={dirPart} />
                </div>
              </div>
            )
          })}
        </div>
        <div className="ft">{AT_HINT}</div>
      </div>
      {side && token && (
        <div className="pop-side">
          <PreviewCard token={token} data={data?.id === token.id ? data.d : null} variant="side" cwd={cwd} home={home} />
        </div>
      )}
    </>
  )
})
