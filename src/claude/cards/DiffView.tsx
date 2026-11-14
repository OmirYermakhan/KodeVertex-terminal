// Изменение файла в карточке действия: заголовок «путь +A −D», кнопки «Открыть в редакторе» /
// «Копировать путь», строки с номерами «было/стало». Как в макете 02 (.diff .a/.d): добавленные и
// удалённые строки — сплошным --add/--del, строки контекста — с подсветкой по расширению.
import { Fragment, memo, useEffect, useMemo, useState } from 'react'
import { openPath } from '../../attach/preview/api'
import { highlightLines, type Piece } from '../../attach/preview/highlight'
import { Markdown } from '../Markdown'
import { diffParts, diffStat, firstChangedLine, type DiffRow, type FileDiff } from '../diff'

/** Строк вида до «Показать всё» (Write большого файла не растягивает ленту). */
export const DIFF_SHOWN = 80
/** Конец вида правки, урезанной при сохранении сессии. */
export const TRUNCATED = '… остальные строки не сохранены'

/** Файлы, которые можно показать как документ (со схемами mermaid). */
const isMarkdown = (path: string) => /\.(md|markdown|mdx)$/i.test(path)

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

/** Путь внутри каталога сессии — относительный («src/Form.tsx»), иначе — как есть. */
export function shownPath(path: string, cwd: string | null | undefined): string {
  if (!cwd || !path.startsWith('/')) return path
  const base = cwd.endsWith('/') ? cwd : cwd + '/'
  return path.startsWith(base) && path.length > base.length ? path.slice(base.length) : path
}

type Entry = { kind: 'row'; row: DiffRow; key: string } | { kind: 'gap'; part: number; count: number | null; expandable: boolean }

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

export const DiffView = memo(function DiffView({ diff, cwd }: { diff: FileDiff; cwd?: string | null }) {
  const parts = useMemo(() => diffParts(diff), [diff])
  const stat = useMemo(() => diffStat(diff), [diff])
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set())
  const [all, setAll] = useState(false)
  const [copied, setCopied] = useState(false)
  const [asDoc, setAsDoc] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])

  // Видимая часть: строки и свёрнутые куски до DIFF_SHOWN (без «Показать ещё»); остальное — cut строк.
  const { entries, cut } = useMemo(() => {
    const entries: Entry[] = []
    let cut = 0
    parts.forEach((p, i) => {
      const rows = p.kind === 'row' ? [p.row] : open.has(i) && p.rows ? p.rows : null
      if (rows) {
        rows.forEach((row, j) => {
          if (!all && entries.length >= DIFF_SHOWN) cut++
          // Ключ — по месту в виде (кусок и строка в нём): развёрнутый кусок выше не пересоздаёт строки ниже.
          else entries.push({ kind: 'row', row, key: p.kind === 'row' ? `r${i}` : `g${i}-${j}` })
        })
        return
      }
      if (p.kind === 'row' || (!all && entries.length >= DIFF_SHOWN)) return
      entries.push({ kind: 'gap', part: i, count: p.count, expandable: !!p.rows })
    })
    return { entries, cut }
  }, [parts, open, all])

  // Подсветка — только видимых строк (Write большого файла не подсвечивается целиком). Новая сторона
  // одним текстом: многострочные строки и комментарии; цвета берут только строки контекста.
  const lit = useMemo(() => {
    const side: DiffRow[] = []
    for (const e of entries) if (e.kind === 'row' && e.row.k !== 'd') side.push(e.row)
    const out = new Map<DiffRow, Piece[]>()
    if (!side.some((r) => r.k === 'n')) return out
    const pieces = highlightLines(side.map((r) => r.t), diff.path)
    side.forEach((r, i) => {
      if (r.k === 'n') out.set(r, pieces[i])
    })
    return out
  }, [entries, diff.path])

  // Ширина колонок номеров — по самому большому номеру вида.
  let max = 0
  for (const p of parts) {
    const rs = p.kind === 'row' ? [p.row] : (p.rows ?? [])
    for (const r of rs) max = Math.max(max, r.o ?? 0, r.n ?? 0)
  }
  const w = max > 0 ? String(max).length : 0

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
        <b className="dv-path" title={path}>
          {shownPath(path, cwd)}
        </b>
        <span className="dv-stat">
          <span className="dv-add">+{stat.add}</span> <span className="dv-del">−{stat.del}</span>
        </span>
        {path && (
          <span className="dv-btns">
            {isMarkdown(path) && (
              <button type="button" className="dv-btn" onClick={() => setAsDoc((v) => !v)}>
                {asDoc ? 'Как изменения' : 'Как документ'}
              </button>
            )}
            <button type="button" className="dv-btn" onClick={edit}>
              Открыть в редакторе
            </button>
            <button type="button" className="dv-btn" onClick={copy}>
              {copied ? 'Скопировано' : 'Копировать путь'}
            </button>
          </span>
        )}
      </div>
      {asDoc && (
        <div className="dv-doc">
          <Markdown text={diff.after.replace(/\n?… остальные строки не сохранены$/, '')} />
        </div>
      )}
      {!asDoc && entries.length > 0 && (
        <div className={'diff dv-body' + (w === 0 ? ' nonum' : '')}>
          {entries.map((e) =>
            e.kind === 'row' ? (
              <Line key={e.key} row={e.row} lit={lit.get(e.row)} w={w} />
            ) : e.expandable ? (
              <button key={`p${e.part}`} type="button" className="dl gap" title="Показать строки" onClick={() => setOpen((s) => new Set(s).add(e.part))}>
                {unchangedLabel(e.count)}
              </button>
            ) : (
              <div key={`p${e.part}`} className="dl gap">
                {unchangedLabel(e.count)}
              </div>
            ),
          )}
          {cut > 0 && (
            <button type="button" className="dl gap" onClick={() => setAll(true)}>
              Показать ещё {cut} {linesWord(cut)}
            </button>
          )}
          {diff.truncated && cut === 0 && <div className="dl gap">{TRUNCATED}</div>}
        </div>
      )}
    </div>
  )
})
