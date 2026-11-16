// ⌘F — строка поиска в ленте справа вверху панели (как в Warp): «N из M», ↵/⇧↵ и ↑/↓ — к
// следующему/предыдущему, «Aa» — с учётом регистра, esc — закрыть. Лента меняется, пока строка
// открыта (вывод, стрим ответа), — совпадения пересчитываются.
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type RefObject } from 'react'
import { clearPaneHighlights, findCount, findRanges, firstVisible, scrollToRange, setPaneHighlights } from './findInFeed'

export const FIND_PLACEHOLDER = 'Найти в ленте'
export const FIND_CASE_TITLE = 'С учётом регистра'
export const FIND_PREV_TITLE = 'Предыдущее (⇧↵)'
export const FIND_NEXT_TITLE = 'Следующее (↵)'
export const FIND_CLOSE_TITLE = 'Закрыть (esc)'
/** Пересчёт совпадений после изменения ленты — не чаще этого (каждый — полный проход DOM ленты). */
export const RECOUNT_MS = 100
/** Поиск по набранному — после паузы в наборе: не полный проход ленты на каждую букву. */
export const TYPE_DEBOUNCE_MS = 100

/** Изменения живого xterm (DOM-рендерер перерисовывает строки на каждом кадре) поиск не пересчитывают. */
function ignored(m: MutationRecord): boolean {
  const el = m.target.nodeType === 1 ? (m.target as Element) : m.target.parentElement
  return !!el?.closest('.live-host, .xterm, .feed-park')
}

export interface FindBarHandle {
  /** Повторный ⌘F: фокус в поле, запрос выделен. */
  focus(): void
}

export interface FindBarProps {
  paneId: string
  feedRef: RefObject<HTMLDivElement | null>
  onClose(): void
}

export const FindBar = forwardRef<FindBarHandle, FindBarProps>(function FindBar({ paneId, feedRef, onClose }, ref) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [ranges, setRanges] = useState<Range[]>([])
  const [index, setIndex] = useState(-1)
  /** Индекс сменил пользователь (или запрос) — к совпадению надо прокрутить. */
  const scrollPending = useRef(false)

  useImperativeHandle(ref, () => ({
    focus: () => {
      inputRef.current?.focus()
      inputRef.current?.select()
    },
  }))
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Новый запрос или «Aa»: с первого видимого совпадения.
  const typeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  /** Отложенный поиск по набранному (ещё не выполнен). */
  const typed = useRef<(() => void) | null>(null)
  useEffect(() => () => clearTimeout(typeTimer.current), [])
  const runTyped = () => {
    clearTimeout(typeTimer.current)
    const f = typed.current
    typed.current = null
    f?.()
  }
  const search = (q: string, cs: boolean) => {
    clearTimeout(typeTimer.current)
    typed.current = null
    const feed = feedRef.current
    const rs = feed ? findRanges(feed, q, cs) : []
    setRanges(rs)
    setIndex(feed ? firstVisible(rs, feed) : -1)
    scrollPending.current = true
  }

  // Лента изменилась — пересчёт без прыжка: номер текущего сохраняется (в пределах числа совпадений).
  useEffect(() => {
    const feed = feedRef.current
    if (!feed || !query || typeof MutationObserver === 'undefined') return
    let timer: ReturnType<typeof setTimeout> | undefined
    const recount = () => {
      timer = undefined
      const rs = findRanges(feed, query, caseSensitive)
      setRanges(rs)
      setIndex((i) => (rs.length === 0 ? -1 : Math.min(Math.max(i, 0), rs.length - 1)))
    }
    // Стрим ответа меняет ленту на каждом куске: пересчёт не чаще RECOUNT_MS.
    const mo = new MutationObserver((ms) => {
      if (ms.every(ignored)) return
      timer ??= setTimeout(recount, RECOUNT_MS)
    })
    mo.observe(feed, { childList: true, subtree: true, characterData: true })
    return () => {
      mo.disconnect()
      clearTimeout(timer)
    }
  }, [query, caseSensitive, feedRef])

  // Подсветка и прокрутка к текущему.
  useEffect(() => {
    const cur = index >= 0 ? (ranges[index] ?? null) : null
    setPaneHighlights(paneId, ranges, cur)
    const feed = feedRef.current
    if (cur && feed && scrollPending.current) scrollToRange(cur, feed)
    scrollPending.current = false
  }, [ranges, index, paneId, feedRef])
  useEffect(() => () => clearPaneHighlights(paneId), [paneId])

  const step = useCallback(
    (d: 1 | -1) => {
      // ↵ сразу после набора — сначала досчитать отложенный поиск (шаг — уже по нему, со следующего рендера).
      if (typed.current) {
        runTyped()
        return
      }
      const n = ranges.length
      if (n === 0) return
      scrollPending.current = true
      setIndex((i) => (i < 0 ? 0 : (i + d + n) % n))
    },
    [ranges.length],
  )

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const plain = !e.metaKey && !e.ctrlKey && !e.altKey
    if (e.key === 'Escape' && plain && !e.shiftKey) {
      e.preventDefault()
      onClose()
    } else if (e.key === 'Enter' && plain) {
      e.preventDefault()
      step(e.shiftKey ? -1 : 1)
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && plain && !e.shiftKey) {
      e.preventDefault()
      step(e.key === 'ArrowDown' ? 1 : -1)
    }
  }

  const count = findCount(index, ranges.length, query)
  const none = !!query && ranges.length === 0
  // Кнопки: mousedown без фокуса — ввод остаётся в поле.
  const keep = (e: React.MouseEvent) => e.preventDefault()
  return (
    <div className="find" role="search">
      <input
        ref={inputRef}
        className={'find-in' + (none ? ' none' : '')}
        value={query}
        placeholder={FIND_PLACEHOLDER}
        aria-label={FIND_PLACEHOLDER}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => {
          const q = e.target.value
          setQuery(q)
          // Пустой запрос — сразу (сбросить счётчик и подсветку), иначе — после паузы в наборе.
          if (!q) return search(q, caseSensitive)
          clearTimeout(typeTimer.current)
          typed.current = () => search(q, caseSensitive)
          typeTimer.current = setTimeout(runTyped, TYPE_DEBOUNCE_MS)
        }}
        onKeyDown={onKeyDown}
      />
      <span className="find-n" aria-live="polite">
        {count}
      </span>
      <button
        type="button"
        className={'find-b find-aa' + (caseSensitive ? ' on' : '')}
        title={FIND_CASE_TITLE}
        aria-label={FIND_CASE_TITLE}
        aria-pressed={caseSensitive}
        onMouseDown={keep}
        onClick={() => {
          setCaseSensitive(!caseSensitive)
          search(query, !caseSensitive)
        }}
      >
        Aa
      </button>
      <button type="button" className="find-b" title={FIND_PREV_TITLE} aria-label={FIND_PREV_TITLE} onMouseDown={keep} onClick={() => step(-1)}>
        ↑
      </button>
      <button type="button" className="find-b" title={FIND_NEXT_TITLE} aria-label={FIND_NEXT_TITLE} onMouseDown={keep} onClick={() => step(1)}>
        ↓
      </button>
      <button type="button" className="find-b" title={FIND_CLOSE_TITLE} aria-label={FIND_CLOSE_TITLE} onMouseDown={keep} onClick={onClose}>
        ✕
      </button>
    </div>
  )
})

export default FindBar
