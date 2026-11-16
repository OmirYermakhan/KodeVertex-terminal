// «Ответить» на выделенный фрагмент ответа Claude: выделение внутри одной карточки ответа —
// рядом с ним кнопка; щелчок (или ⌘L) кладёт фрагмент в строку ввода значком-цитатой.
import { Menu } from '@tauri-apps/api/menu'
import { openUrl } from '@tauri-apps/plugin-opener'
import { useEffect, useRef, useState, type RefObject } from 'react'

export interface QuoteSel {
  /** Элемент ленты (ответ Claude), из которого выделено. */
  id: string
  text: string
  /** Конец выделения на экране — для кнопки. */
  rect: { left: number; top: number; right: number; bottom: number }
}

const cardOf = (n: Node | null): HTMLElement | null => {
  const el = n instanceof HTMLElement ? n : (n?.parentElement ?? null)
  return el?.closest<HTMLElement>('.card[data-item-id]') ?? null
}

/** Выделение внутри текста одного ответа Claude в ленте feed; иначе null. */
export function quoteSelection(feed: HTMLElement | null, sel: Selection | null = window.getSelection()): QuoteSel | null {
  if (!feed || !sel || sel.isCollapsed || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0)
  const card = cardOf(range.startContainer)
  if (!card || card !== cardOf(range.endContainer) || !feed.contains(card)) return null
  // Только текст ответа (не заголовок карточки и не кнопки).
  const body = card.querySelector('.ans-body')
  if (!body || !body.contains(range.commonAncestorContainer)) return null
  const text = sel.toString().trim()
  const id = card.dataset.itemId
  if (!text || !id) return null
  const r = range.getBoundingClientRect?.()
  return { id, text, rect: r ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : { left: 0, top: 0, right: 0, bottom: 0 } }
}

export const QUOTE_LABEL = 'Ответить'

/**
 * Правый щелчок по выделению в ответе — своё меню macOS: «Ответить», «Копировать», «Найти в Google».
 * Системное меню WebKit (Look Up, Перевести, Речь) пополнить из страницы нельзя — оно заменяется только здесь.
 */
export async function showQuoteMenu(q: QuoteSel, onQuote: (q: QuoteSel) => void): Promise<void> {
  const menu = await Menu.new({
    items: [
      { id: 'kv-reply', text: `↩ ${QUOTE_LABEL}`, accelerator: 'CmdOrCtrl+L', action: () => {
        onQuote(q)
        window.getSelection()?.removeAllRanges()
      } },
      { item: 'Separator' },
      { item: 'Copy', text: 'Копировать' },
      { id: 'kv-google', text: 'Найти в Google', action: () => {
        openUrl(`https://www.google.com/search?q=${encodeURIComponent(q.text)}`).catch(() => {})
      } },
    ],
  })
  try {
    await menu.popup()
  } finally {
    menu.close().catch(() => {})
  }
}

export function QuoteReply({ feedRef, onQuote }: { feedRef: RefObject<HTMLElement | null>; onQuote: (q: QuoteSel) => void }) {
  const [q, setQ] = useState<QuoteSel | null>(null)
  const quoteRef = useRef(onQuote)
  useEffect(() => {
    quoteRef.current = onQuote
  }, [onQuote])
  useEffect(() => {
    let raf = 0
    const update = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => setQ(quoteSelection(feedRef.current)))
    }
    const feed = feedRef.current
    const onMenu = (e: MouseEvent) => {
      // У ссылок своего меню WKWebView нет: «Открыть ссылку» открыло бы её в главном окне.
      if ((e.target as Element | null)?.closest?.('a[href]')) {
        e.preventDefault()
        return
      }
      const sel = quoteSelection(feedRef.current)
      if (!sel) return
      e.preventDefault()
      showQuoteMenu(sel, (x) => quoteRef.current(x)).catch(() => {})
    }
    feed?.addEventListener('contextmenu', onMenu)
    document.addEventListener('selectionchange', update)
    feed?.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('selectionchange', update)
      feed?.removeEventListener('scroll', update)
      feed?.removeEventListener('contextmenu', onMenu)
      window.removeEventListener('resize', update)
    }
  }, [feedRef])
  if (!q) return null
  // Под концом выделения; у нижнего края окна — над ним.
  const below = q.rect.bottom + 34 < window.innerHeight
  const top = below ? q.rect.bottom + 6 : q.rect.top - 32
  const left = Math.max(8, Math.min(q.rect.right - 60, window.innerWidth - 130))
  return (
    <button
      type="button"
      className="quote-btn"
      style={{ top, left }}
      // Щелчок не должен снять выделение до того, как оно прочитано.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        onQuote(q)
        window.getSelection()?.removeAllRanges()
        setQ(null)
      }}
    >
      ↩ {QUOTE_LABEL} <kbd>⌘L</kbd>
    </button>
  )
}
