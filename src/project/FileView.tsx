import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Hunk } from '../claude/diff'
import { openPath } from '../attach/preview/api'
import { highlightLines, type Piece } from '../attach/preview/highlight'
import { formatSize } from '../format'
import { gitDiff, projectRead, type FileText } from './api'
import { statusOf, useProject } from './store'
import { parseUnified } from './unified'

/** Высота строки и отступ сверху (макет 07 `.code`: 13px/21px, padding-top 6px). */
const LH = 21
const PAD = 6
/** Запас строк над и под видимым окном. */
const OVER = 30
/** Подсветка кусками: большой файл не красим целиком за раз (на стыке кусков многострочный комментарий может потерять цвет). */
export const CHUNK = 2000

export type Mark = 'a' | 'm'

/**
 * Полоски на полях относительно HEAD: в каждом блоке подряд идущих «−/+» первые добавленные строки
 * в паре с удалёнными — изменённые (m), остальные — добавленные (a). Только удаление — без полоски.
 */
export function gutterMarks(hunks: Hunk[]): Map<number, Mark> {
  const out = new Map<number, Mark>()
  for (const h of hunks) {
    let line = h.newStart
    let dels = 0
    let adds = 0
    for (const l of h.lines) {
      const c = l[0]
      if (c === '-') {
        dels++
      } else if (c === '+') {
        out.set(line++, adds++ < dels ? 'm' : 'a')
      } else {
        line++
        dels = 0
        adds = 0
      }
    }
  }
  return out
}

/** Хлебные крошки (макет 07 `.crumb`): «app › … › payments › » и имя файла. */
export function crumbs(rel: string): { dirs: string; name: string } {
  const parts = rel.split('/')
  const name = parts.pop() ?? rel
  const dirs = parts.length > 2 ? [parts[0], '…', parts[parts.length - 1]] : parts
  return { dirs: dirs.map((d) => `${d} › `).join(''), name }
}

/** Просмотр файла во вкладке (макет 07 `.ebar` + `.code`): только чтение, в DOM — только видимые строки. */
export default function FileView({ rel }: { rel: string }) {
  const root = useProject((s) => s.root)
  const changes = useProject((s) => s.changes)
  const notGit = useProject((s) => s.notGit)
  const cursor = useProject((s) => s.cursors[rel] ?? 1)
  const focusLine = useProject((s) => s.focusLine)
  const [data, setData] = useState<FileText | null>(null)
  const [marks, setMarks] = useState<Map<number, Mark>>(() => new Map())
  const [top, setTop] = useState(0)
  const [viewH, setViewH] = useState(0)
  const codeRef = useRef<HTMLDivElement>(null)
  const status = statusOf(changes, rel)
  const name = rel.slice(rel.lastIndexOf('/') + 1)

  // Перечитываем при каждом обновлении git-статуса (store.refresh после действий Claude, фокуса окна…).
  // Пока читается — показываем прежнее содержимое, без мигания.
  useEffect(() => {
    if (!root) return
    let alive = true
    projectRead(root, rel).then(
      (d) => alive && setData(d),
      (e) => alive && setData({ kind: 'error', message: String(e) }),
    )
    // Неотслеживаемый — без полосок (как в AS); чистый файл — diff пуст, не спрашиваем git.
    if (notGit || (status !== 'mod' && status !== 'add')) setMarks(new Map())
    else
      gitDiff(root, rel, null).then(
        (t) => alive && setMarks(gutterMarks(parseUnified(t).hunks)),
        () => alive && setMarks(new Map()),
      )
    return () => {
      alive = false
    }
  }, [root, rel, changes, notGit, status])

  const lines = data?.kind === 'text' ? data.lines : null
  const hasText = lines !== null
  // Кэш подсветки по кускам; новый массив строк (перечитали) — новый кэш.
  const chunks = useMemo(() => new Map<number, Piece[][]>(), [lines])
  const piecesOf = (i: number): Piece[] => {
    const c = Math.floor(i / CHUNK)
    let hl = chunks.get(c)
    if (!hl) {
      hl = highlightLines(lines!.slice(c * CHUNK, (c + 1) * CHUNK), name)
      chunks.set(c, hl)
    }
    return hl[i - c * CHUNK] ?? []
  }

  useLayoutEffect(() => {
    const el = codeRef.current
    if (!el) return
    const measure = () => setViewH(el.clientHeight)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [hasText])

  // Открыли со строкой (из поиска/ссылки) — прокручиваем к ней, она по центру.
  useLayoutEffect(() => {
    if (focusLine === null || !lines) return
    const el = codeRef.current
    const h = viewH || el?.clientHeight || 0
    const y = Math.max(0, PAD + (focusLine - 1) * LH - h / 2)
    if (el) el.scrollTop = y
    setTop(y)
    useProject.setState({ focusLine: null })
  }, [focusLine, lines, viewH])

  const open = () => {
    if (root) void openPath(`${root}/${rel}`, 'editor', cursor).catch(() => {})
  }
  const { dirs } = crumbs(rel)

  let body
  if (!data) body = null
  else if (data.kind === 'missing') body = <div className="ed-msg">Файл удалён</div>
  else if (data.kind === 'error') body = <div className="ed-msg">{data.message}</div>
  else if (data.kind === 'binary')
    body = (
      <div className="ed-msg">
        Бинарный файл · {formatSize(data.size)} ·{' '}
        <button type="button" className="ed-link" onClick={open}>
          Открыть в редакторе
        </button>
      </div>
    )
  else {
    const n = data.lines.length
    const h = viewH || 800 // до замера (и в тестах) — примерно один экран
    const start = Math.max(0, Math.floor((top - PAD) / LH) - OVER)
    const end = Math.min(n, Math.ceil((top + h) / LH) + OVER)
    const rows = []
    for (let i = start; i < end; i++) {
      const m = marks.get(i + 1)
      rows.push(
        <div
          key={i}
          className={i + 1 === cursor ? 'ln cur' : 'ln'}
          onClick={() => useProject.getState().setCursor(rel, i + 1)}
        >
          <span className="g">{i + 1}</span>
          <span className={m ? `vc ${m}` : 'vc'} />
          {piecesOf(i).map((p, j) =>
            p.cls ? (
              <span key={j} className={p.cls}>
                {p.text}
              </span>
            ) : (
              p.text
            ),
          )}
        </div>,
      )
    }
    body = (
      <>
        {data.truncated && (
          <div className="ed-note">
            Файл большой — показаны первые {n} строк ·{' '}
            <button type="button" className="ed-link" onClick={open}>
              Открыть в редакторе
            </button>
          </div>
        )}
        <div className="code" ref={codeRef} onScroll={(e) => setTop(e.currentTarget.scrollTop)}>
          <div className="code-in" style={{ paddingTop: start * LH, paddingBottom: (n - end) * LH }}>
            {rows}
          </div>
        </div>
      </>
    )
  }

  return (
    <div className="ed-body fv">
      <div className="ebar">
        <span className="crumb">
          {dirs}
          <b>{name}</b>
        </span>
        <span className="ro">🔒 только чтение</span>
        <button type="button" className="ebtn" onClick={open}>
          Открыть в редакторе
        </button>
      </div>
      {body}
    </div>
  )
}
