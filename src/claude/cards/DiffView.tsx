// Изменение файла в карточке действия: заголовок «путь +A −D», кнопки «Открыть в редакторе» /
// «Копировать путь», строки с номерами «было/стало» и подсветкой по расширению.
import { Fragment, memo, useEffect, useMemo, useState, type ReactNode } from 'react'
import { openPath } from '../../attach/preview/api'
import { highlightLines, type Piece } from '../../attach/preview/highlight'
import { diffParts, diffStat, firstChangedLine, type DiffPart, type DiffRow, type FileDiff } from '../diff'

/** Строк вида до «Показать всё» (Write большого файла не растягивает ленту). */
export const DIFF_SHOWN = 80

const MARK = { a: '+', d: '−', n: ' ' } as const

function linesWord(n: number): string {
  const m10 = n % 10
  const m100 = n % 100
  return m10 === 1 && m100 !== 11 ? 'строка' : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? 'строки' : 'строк'
}

/** Подпись свёрнутого куска; сколько строк, неизвестно (между правками MultiEdit) — «…». */
export function unchangedLabel(n: number | null): string {
  return n === null ? '…' : `… ${n} ${linesWord(n)} без изменений`
}

/** Подсветка строк вида: старая и новая стороны — каждая одним текстом (многострочные строки и комментарии). */
function highlight(parts: DiffPart[], path: string): Map<DiffRow, Piece[]> {
  const rows: DiffRow[] = []
  for (const p of parts) {
    if (p.kind === 'row') rows.push(p.row)
    else if (p.rows) rows.push(...p.rows)
  }
  const oldSide = rows.filter((r) => r.k !== 'a')
  const newSide = rows.filter((r) => r.k !== 'd')
  const out = new Map<DiffRow, Piece[]>()
  const litOld = highlightLines(oldSide.map((r) => r.t), path)
  const litNew = highlightLines(newSide.map((r) => r.t), path)
  oldSide.forEach((r, i) => out.set(r, litOld[i]))
  newSide.forEach((r, i) => out.set(r, litNew[i]))
  return out
}

function Line({ row, lit, w }: { row: DiffRow; lit: Piece[] | undefined; w: number }) {
  const pieces = lit ?? (row.t ? [{ text: row.t }] : [])
  return (
    <div className={'dl ' + row.k}>
      <span className="dn" style={{ width: `${w}ch` }}>
        {row.o ?? ''}
      </span>
      <span className="dn" style={{ width: `${w}ch` }}>
        {row.n ?? ''}
      </span>
      <span className="dm">{MARK[row.k]}</span>
      <span className="dt">
        {pieces.map((p, j) =>
          p.cls ? (
            <span key={j} className={p.cls}>
              {p.text}
            </span>
          ) : (
            <Fragment key={j}>{p.text}</Fragment>
          ),
        )}
      </span>
    </div>
  )
}

export const DiffView = memo(function DiffView({ diff }: { diff: FileDiff }) {
  const parts = useMemo(() => diffParts(diff), [diff])
  const lit = useMemo(() => highlight(parts, diff.path), [parts, diff.path])
  const stat = useMemo(() => diffStat(diff), [diff])
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set())
  const [all, setAll] = useState(false)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])

  // Ширина колонок номеров — по самому большому номеру.
  let max = 0
  for (const p of parts) {
    const rs = p.kind === 'row' ? [p.row] : (p.rows ?? [])
    for (const r of rs) max = Math.max(max, r.o ?? 0, r.n ?? 0)
  }
  const w = max > 0 ? String(max).length : 0

  const lines: ReactNode[] = []
  let count = 0
  let cut = 0
  parts.forEach((p, i) => {
    const rows = p.kind === 'row' ? [p.row] : open.has(i) && p.rows ? p.rows : null
    if (rows) {
      for (const r of rows) {
        if (!all && count >= DIFF_SHOWN) cut++
        else lines.push(<Line key={`${i}-${r.o ?? ''}-${r.n ?? ''}-${count}`} row={r} lit={lit.get(r)} w={w} />)
        count++
      }
      return
    }
    if (p.kind === 'row' || (!all && count >= DIFF_SHOWN)) return
    count++
    const label = unchangedLabel(p.count)
    lines.push(
      p.rows ? (
        <button key={`g${i}`} type="button" className="dl gap" title="Показать строки" onClick={() => setOpen((s) => new Set(s).add(i))}>
          {label}
        </button>
      ) : (
        <div key={`g${i}`} className="dl gap">
          {label}
        </div>
      ),
    )
  })

  const path = diff.path
  const copy = () => {
    navigator.clipboard
      ?.writeText(path)
      .then(() => setCopied(true))
      .catch(() => {})
  }
  const edit = () => {
    openPath(path, 'editor', firstChangedLine(diff)).catch(() => {})
  }
  return (
    <div className="dv">
      <div className="dv-h">
        <b className="dv-path">{path}</b>
        <span className="dv-stat">
          <span className="dv-add">+{stat.add}</span> <span className="dv-del">−{stat.del}</span>
        </span>
        {path && (
          <span className="dv-btns">
            <button type="button" className="dv-btn" onClick={edit}>
              Открыть в редакторе
            </button>
            <button type="button" className="dv-btn" onClick={copy}>
              {copied ? 'Скопировано' : 'Копировать путь'}
            </button>
          </span>
        )}
      </div>
      {lines.length > 0 && (
        <div className={'diff dv-body' + (w === 0 ? ' nonum' : '')}>
          {lines}
          {cut > 0 && (
            <button type="button" className="dl gap" onClick={() => setAll(true)}>
              Показать ещё {cut} {linesWord(cut)}
            </button>
          )}
        </div>
      )}
    </div>
  )
})
