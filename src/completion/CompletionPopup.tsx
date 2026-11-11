// Вид попапа подсказок путей: список слева, превью подсвеченного элемента справа.
import { useEffect, useRef, type ReactNode } from 'react'
import { foldForMatch, matchIndices } from './completion'
import type { CompletionState, FsPreviewTS } from './useCompletion'

export const LIST_WIDTH = 280
export const PREVIEW_WIDTH = 300
const ROW_HEIGHT = 22
const MAX_ROWS = 10
const HINT_HEIGHT = 24

/** Полная высота попапа (с рамкой) — для выбора: над строкой курсора или под ней. */
export function popupHeight(count: number): number {
  return Math.min(count, MAX_ROWS) * ROW_HEIGHT + HINT_HEIGHT + 2
}

/** Индексы совпавших кластеров name (см. foldForMatch) — той же логикой, что fuzzyScore. */
export function matchPositions(query: string, name: string): Set<number> {
  const out = new Set<number>()
  if (query === '') return out
  const n = foldForMatch(name)
  const m = matchIndices(foldForMatch(query).chars, n.chars)
  for (const i of m?.idx ?? []) out.add(n.owner[i])
  return out
}

function highlight(query: string, name: string): ReactNode[] {
  const hit = matchPositions(query, name)
  const out: ReactNode[] = []
  let run = ''
  let bold = false
  const flush = () => {
    if (run) out.push(bold ? <b key={out.length}>{run}</b> : run)
    run = ''
  }
  // По кластерам: суррогатная пара и буква с диакритикой подсвечиваются целиком.
  foldForMatch(name).clusters.forEach((c, i) => {
    if (hit.has(i) !== bold) {
      flush()
      bold = !bold
    }
    run += c
  })
  flush()
  return out
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`
}

function Preview({ p }: { p: FsPreviewTS }) {
  switch (p.kind) {
    case 'dir':
      return (
        <>
          {p.entries.map((e) => (
            <div key={e.name} className={e.isDir ? 'cp-pdir' : undefined}>
              {e.isDir ? <span className="cp-icon">▸</span> : <span className="cp-icon" />}
              {e.name}
            </div>
          ))}
          {p.entries.length === 0 && <div className="cp-muted">Пусто</div>}
          {p.total > p.entries.length && <div className="cp-muted">… ещё {p.total - p.entries.length}</div>}
        </>
      )
    case 'text':
      return (
        <>
          <div>{p.lines.join('\n')}</div>
          {p.truncated && <div className="cp-muted">…</div>}
        </>
      )
    case 'binary':
      return <div className="cp-muted">Двоичный файл · {formatSize(p.size)}</div>
    case 'error':
      return <div className="cp-err">{p.message}</div>
  }
}

export interface CompletionPopupProps {
  state: CompletionState
  x: number
  y: number
  onPick(i: number): void
  /** false — справа не хватает места, превью скрыто. */
  previewFits?: boolean
}

export function CompletionPopup({ state, x, y, onPick, previewFits = true }: CompletionPopupProps) {
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const row = listRef.current?.children[state.selected] as HTMLElement | undefined
    row?.scrollIntoView?.({ block: 'nearest' })
  }, [state.selected, state.items])

  if (!state.open || !state.ctx) return null
  const query = state.ctx.namePart
  const enter = state.ctx.command === 'cd' ? '↵ перейти' : '↵ подставить'
  const bodyHeight = Math.min(state.items.length, MAX_ROWS) * ROW_HEIGHT

  return (
    <div className="cp" style={{ left: x, top: y }}>
      <div className="cp-body" style={{ height: bodyHeight }}>
        <div className="cp-list" ref={listRef} role="listbox" style={{ width: LIST_WIDTH }}>
          {state.items.map((it, i) => (
            <div
              key={it.name}
              role="option"
              aria-selected={i === state.selected}
              className={'cp-item' + (it.isDir ? ' dir' : '') + (i === state.selected ? ' sel' : '')}
              style={{ height: ROW_HEIGHT, lineHeight: `${ROW_HEIGHT}px` }}
              // mousedown, а не click: фокус остаётся в терминале.
              onMouseDown={(e) => {
                e.preventDefault()
                onPick(i)
              }}
            >
              {it.isDir ? <span className="cp-icon">▸</span> : <span className="cp-icon" />}
              {highlight(query, it.name)}
            </div>
          ))}
        </div>
        {previewFits && (
          <div className="cp-preview" style={{ width: PREVIEW_WIDTH }}>
            {state.preview && <Preview p={state.preview} />}
          </div>
        )}
      </div>
      <div className="cp-hint" style={{ height: HINT_HEIGHT, lineHeight: `${HINT_HEIGHT}px` }}>
        ↑↓ выбрать · Tab подставить · {enter} · esc
      </div>
    </div>
  )
}

export default CompletionPopup
