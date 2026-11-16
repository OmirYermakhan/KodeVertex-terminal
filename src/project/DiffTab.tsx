import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { highlightLines, type Piece } from '../attach/preview/highlight'
import { unchangedLabel } from '../claude/cards/DiffView'
import { diffParts, type DiffPart, type DiffRow } from '../claude/diff'
import { gitDiff } from './api'
import { plural } from './changeRow'
import { useProject } from './store'
import { parseUnified } from './unified'

/** Строк до «… ещё N строк · Показать всё»: огромный diff не рисуется целиком сразу. */
export const DIFF_TAB_SHOWN = 1000
/** Высота строки и отступ сверху (`.dvw .code`: line-height 21px, padding-top 4px). */
const LH = 21
const PAD = 4
/** Запас строк над и под видимым окном. */
const OVER = 30
/** Подсветка кусками строк новой стороны (как в FileView): красим только то, что видно. */
const CHUNK = 2000
const TRUNCATED = 'Изменения урезаны: больше 4 МБ'
const FILE_CUT = 'Файл усечён'
const MARK = { a: '+', d: '−', n: ' ' } as const

type Loaded = { kind: 'text'; text: string } | { kind: 'error'; message: string }
type Entry = { kind: 'row'; row: DiffRow; key: string } | { kind: 'gap'; key: string; count: number | null }

function Line({ row, lit }: { row: DiffRow; lit: Piece[] | undefined }) {
  const pieces = lit ?? [{ text: row.t }]
  return (
    <div className={row.k === 'n' ? 'dl' : `dl ${row.k}`}>
      <span className="g">{row.o ?? ''}</span>
      <span className="g">{row.n ?? ''}</span>
      <span className="mk">{MARK[row.k]}</span>
      {pieces.map((p, j) =>
        p.cls ? (
          <span key={j} className={p.cls}>
            {p.text}
          </span>
        ) : (
          <Fragment key={j}>{p.text}</Fragment>
        ),
      )}
    </div>
  )
}

/**
 * Изменения файла во вкладке просмотра (макет 07 `.dvh` + `.dl`): локальные (rev = null, «HEAD → рабочая копия»)
 * или в коммите. Строки — как в DiffView (diffParts), вид — два столбца номеров, метка, тонированный фон.
 */
export default function DiffTab({ rel, rev, oldPath }: { rel: string; rev: string | null; oldPath?: string }) {
  const root = useProject((s) => s.root)
  // Локальные изменения перечитываются при каждом ответе обновления статуса (tick: и когда список
  // файлов тот же — правка в уже изменённом файле, ↻); коммит не меняется.
  const changes = useProject((s) => (rev === null ? s.changes : null))
  const tick = useProject((s) => (rev === null ? s.tick : 0))
  // Локально удалённый: файла на диске нет — «Открыть файл» не показываем.
  const deleted = useProject((s) => rev === null && s.changes?.some((c) => c.path === rel && c.status === 'D') === true)
  const [data, setData] = useState<Loaded | null>(null)
  const [all, setAll] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!root) return
    let alive = true
    gitDiff(root, rel, rev, oldPath ?? null).then(
      (text) => alive && setData({ kind: 'text', text }),
      (e) => alive && setData({ kind: 'error', message: String(e) }),
    )
    return () => {
      alive = false
    }
  }, [root, rel, rev, oldPath, changes, tick])

  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])

  const text = data?.kind === 'text' ? data.text : null
  const parsed = useMemo(() => (text === null ? null : parseUnified(text)), [text])
  const isNew = text !== null && /^(new file mode|--- \/dev\/null)/m.test(text)
  const binary = text !== null && /^(Binary files |GIT binary patch)/m.test(text)

  const parts = useMemo((): DiffPart[] => {
    if (!parsed || parsed.hunks.length === 0) return []
    const p = diffParts({ path: rel, before: '', after: '', hunks: parsed.hunks })
    // Строки до первого куска не показываем (как в макете — вид начинается с куска).
    return p[0]?.kind === 'gap' ? p.slice(1) : p
  }, [parsed, rel])

  const { entries, cut } = useMemo(() => {
    const entries: Entry[] = []
    let cut = 0
    parts.forEach((p, i) => {
      if (!all && entries.length >= DIFF_TAB_SHOWN) {
        if (p.kind === 'row') cut++
        return
      }
      if (p.kind === 'row') entries.push({ kind: 'row', row: p.row, key: `r${i}` })
      else entries.push({ kind: 'gap', key: `g${i}`, count: p.count })
    })
    return { entries, cut }
  }, [parts, all])

  // Подсветка — новой стороной (многострочные комментарии), кусками по CHUNK строк и только видимых;
  // цвета берут только строки контекста.
  const side = useMemo(() => {
    const texts: string[] = []
    const at = new Map<DiffRow, number>()
    let context = false
    for (const e of entries) {
      if (e.kind !== 'row' || e.row.k === 'd') continue
      at.set(e.row, texts.length)
      texts.push(e.row.t)
      if (e.row.k === 'n') context = true
    }
    return { texts, at, context, chunks: new Map<number, Piece[][]>() }
  }, [entries])
  const litOf = (row: DiffRow): Piece[] | undefined => {
    if (row.k !== 'n' || !side.context) return undefined
    const i = side.at.get(row)
    if (i === undefined) return undefined
    const c = Math.floor(i / CHUNK)
    let hl = side.chunks.get(c)
    if (!hl) {
      hl = highlightLines(side.texts.slice(c * CHUNK, (c + 1) * CHUNK), rel)
      side.chunks.set(c, hl)
    }
    return hl[i - c * CHUNK]
  }

  // Видимое окно строк: в DOM — только оно (± OVER), как в FileView.
  const codeRef = useRef<HTMLDivElement>(null)
  const [top, setTop] = useState(0)
  const [viewH, setViewH] = useState(0)
  const hasRows = entries.length > 0
  useLayoutEffect(() => {
    const el = codeRef.current
    if (!el) return
    const measure = () => setViewH(el.clientHeight)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [hasRows])

  const short = rev ? rev.slice(0, 7) : null
  const badge = short === null ? 'HEAD → рабочая копия' : isNew ? `новый файл в ${short}` : short
  const copy = () => {
    if (!rev) return
    navigator.clipboard
      ?.writeText(rev)
      .then(() => setCopied(true))
      .catch(() => {})
  }

  const h = viewH || 800 // до замера (и в тестах) — примерно один экран
  const win = {
    start: Math.max(0, Math.floor((top - PAD) / LH) - OVER),
    end: Math.min(entries.length, Math.ceil((top + h) / LH) + OVER),
  }

  let body
  if (!data) body = null
  else if (data.kind === 'error') body = <div className="ed-msg">{data.message}</div>
  else if (binary) body = <div className="ed-msg">Бинарный файл</div>
  else if (entries.length === 0 && !parsed?.truncated && !parsed?.fileCut) body = <div className="ed-msg">Изменений нет</div>
  else
    body = (
      <div className="code" ref={codeRef} onScroll={(e) => setTop(e.currentTarget.scrollTop)}>
        <div className="code-in" style={{ paddingTop: win.start * LH }}>
          {entries.slice(win.start, win.end).map((e) =>
            e.kind === 'row' ? (
              <Line key={e.key} row={e.row} lit={litOf(e.row)} />
            ) : (
              <div key={e.key} className="dl gap">
                {unchangedLabel(e.count)}
              </div>
            ),
          )}
          {win.end < entries.length && <div style={{ height: (entries.length - win.end) * LH }} />}
          {cut > 0 && (
            <button type="button" className="dl gap" onClick={() => setAll(true)}>
              {`… ещё ${cut} ${plural(cut, 'строка', 'строки', 'строк')} · Показать всё`}
            </button>
          )}
          {parsed?.fileCut && <div className="dl gap">{FILE_CUT}</div>}
          {parsed?.truncated && <div className="dl gap">{TRUNCATED}</div>}
        </div>
      </div>
    )

  return (
    <div className="ed-body dvw">
      <div className="dvh">
        <b title={oldPath ? `${oldPath} → ${rel}` : rel}>{oldPath ? `${oldPath} → ${rel}` : rel}</b>
        {parsed && parsed.add > 0 && <span className="pa">+{parsed.add}</span>}
        {parsed && parsed.del > 0 && <span className="pd">−{parsed.del}</span>}
        <span className="ro">{badge}</span>
        {rev === null ? (
          !deleted && (
            <button type="button" className="ebtn" onClick={() => useProject.getState().openFile(rel)}>
              Открыть файл
            </button>
          )
        ) : (
          <button type="button" className="ebtn" onClick={copy}>
            {copied ? 'Скопировано' : 'Копировать хэш'}
          </button>
        )}
      </div>
      {body}
    </div>
  )
}
