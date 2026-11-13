import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Markdown } from '../Markdown'

/** Размер текста в режиме чтения: свой, отдельно от ленты (читают обычно крупнее). */
export const READER_SIZES = [14, 15, 16, 17, 18, 19, 20, 22, 24] as const
export const READER_DEFAULT = 17
const KEY = 'kv.reader.size'

export function loadReaderSize(): number {
  try {
    const v = Number(localStorage.getItem(KEY))
    return (READER_SIZES as readonly number[]).includes(v) ? v : READER_DEFAULT
  } catch {
    return READER_DEFAULT
  }
}

function saveReaderSize(v: number) {
  try {
    localStorage.setItem(KEY, String(v))
  } catch {
    // нет хранилища — размер просто не запомнится
  }
}

export function stepReaderSize(v: number, d: 1 | -1): number {
  const i = READER_SIZES.indexOf(v as (typeof READER_SIZES)[number])
  const j = Math.min(READER_SIZES.length - 1, Math.max(0, (i < 0 ? READER_SIZES.indexOf(READER_DEFAULT) : i) + d))
  return READER_SIZES[j]
}

/** Ответ стоит открыть в режиме чтения: длинный или с заголовками. */
export const isLongAnswer = (text: string) => text.length > 1200 || /^#{1,3} /m.test(text)

interface TocItem {
  level: number
  text: string
}

/**
 * Режим чтения ответа: на всю панель, колонка по центру, крупный текст,
 * оглавление по заголовкам с текущим разделом, прогресс, A−/A+, ⎋ — выход.
 */
export function ReaderView({ title, text, streaming, onClose }: { title: string; text: string; streaming: boolean; onClose(): void }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const heads = useRef<HTMLElement[]>([])
  const [toc, setToc] = useState<TocItem[]>([])
  const [active, setActive] = useState(0)
  const [progress, setProgress] = useState(0)
  const [size, setSize] = useState(loadReaderSize)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    scrollRef.current?.focus()
  }, [])

  const onScroll = useCallback(() => {
    const sc = scrollRef.current
    if (!sc) return
    const max = sc.scrollHeight - sc.clientHeight
    setProgress(max > 0 ? Math.min(1, sc.scrollTop / max) : 1)
    const top = sc.getBoundingClientRect().top + 90
    let cur = 0
    // В самом начале текущий раздел — первый; дальше — последний заголовок выше верха окна.
    if (sc.scrollTop > 0)
      heads.current.forEach((h, i) => {
        if (h.getBoundingClientRect().top <= top) cur = i
      })
    setActive(cur)
  }, [])

  // Заголовки — из отрисованного текста (h1–h3); при стриминге список растёт.
  useLayoutEffect(() => {
    const els = Array.from(bodyRef.current?.querySelectorAll<HTMLElement>('h1, h2, h3') ?? [])
    heads.current = els
    setToc(els.map((h) => ({ level: Number(h.tagName[1]), text: h.textContent ?? '' })))
    onScroll()
  }, [text, size, onScroll])

  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])

  const resize = (d: 1 | -1) => {
    const v = stepReaderSize(size, d)
    setSize(v)
    saveReaderSize(v)
  }

  const jump = (i: number) => {
    const sc = scrollRef.current
    const h = heads.current[i]
    if (!sc || !h) return
    sc.scrollTo({ top: sc.scrollTop + h.getBoundingClientRect().top - sc.getBoundingClientRect().top - 16, behavior: 'smooth' })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
  }

  const showToc = toc.length >= 2
  return (
    <div className="reader" role="dialog" aria-label="Режим чтения" onKeyDown={onKeyDown}>
      <div className="rd-bar">
        <span className="rd-title">{title}</span>
        <span className="rd-tools">
          <button type="button" onClick={() => resize(-1)} aria-label="Мельче" disabled={size === READER_SIZES[0]}>
            A−
          </button>
          <button type="button" onClick={() => resize(1)} aria-label="Крупнее" disabled={size === READER_SIZES[READER_SIZES.length - 1]}>
            A+
          </button>
          <button type="button" onClick={() => navigator.clipboard?.writeText(text).then(() => setCopied(true), () => {})}>
            {copied ? 'Скопировано' : 'Копировать'}
          </button>
          <button type="button" className="rd-close" onClick={onClose}>
            Закрыть <kbd>⎋</kbd>
          </button>
        </span>
        <div className="rd-progress" style={{ transform: `scaleX(${progress})` }} />
      </div>
      <div className="rd-main">
        {showToc && (
          <nav className="rd-toc" aria-label="Оглавление">
            <div className="rd-toc-h">Содержание</div>
            {toc.map((t, i) => (
              <button
                type="button"
                key={i}
                className={'rd-toc-i l' + t.level + (i === active ? ' on' : '')}
                onClick={() => jump(i)}
                title={t.text}
              >
                {t.text}
              </button>
            ))}
          </nav>
        )}
        <div className="rd-scroll" ref={scrollRef} tabIndex={-1} onScroll={onScroll}>
          <div className="rd-body" ref={bodyRef} style={{ ['--rd-size' as string]: `${size}px` }}>
            <Markdown text={text} streaming={streaming} />
          </div>
        </div>
      </div>
    </div>
  )
}
