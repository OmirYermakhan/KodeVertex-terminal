// ⌘F — поиск в ленте: совпадения — диапазоны (Range) по тексту DOM ленты. Подсветка — через
// CSS Custom Highlight API: ни карточки React, ни замороженный HTML блоков не меняются.
// Без API (jsdom, старый WebKit) поиск, счётчик и прокрутка работают, подсветки просто нет.

/** Имена подсветок в CSS (`::highlight(...)`, global.css). */
export const FIND_HIGHLIGHT = 'kv-find'
export const FIND_CURRENT = 'kv-find-cur'

/** Что не ищем: кнопки и панельки ленты, спрятанный/живой xterm (у него свой экран). */
const SKIP = 'button, .hover-act, .feed-park, .live-host, .xterm, [aria-hidden="true"]'
/** Граница строки: совпадение не склеивает соседние строки вывода и абзацы. */
const BLOCK = 'div, p, li, pre, td, th, tr, h1, h2, h3, h4, h5, h6, blockquote, summary'

/** «N из M»; пустой запрос — ничего. */
export function findCount(index: number, total: number, query: string): string {
  if (!query) return ''
  return `${total === 0 ? 0 : index + 1} из ${total}`
}

/** Регистр без смены длины строки (иначе смещения разъедутся с DOM): «İ» и т. п. остаются как есть. */
export function foldCase(s: string): string {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    const l = c.toLowerCase()
    out += l.length === 1 ? l : c
  }
  return out
}

interface Piece {
  node: Text
  /** Начало текста узла в строке элемента. */
  at: number
}

/** Текст одного элемента ленты и узлы, из которых он собран. */
function collect(el: Element): { text: string; pieces: Piece[] } {
  const doc = el.ownerDocument
  const walker = doc.createTreeWalker(el, 4 /* NodeFilter.SHOW_TEXT */, {
    acceptNode: (n) => (n.parentElement?.closest(SKIP) ? 2 /* FILTER_REJECT */ : 1 /* FILTER_ACCEPT */),
  })
  let text = ''
  const pieces: Piece[] = []
  let lastBlock: Element | null = null
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text
    if (!t.data) continue
    const block = t.parentElement?.closest(BLOCK) ?? null
    if (pieces.length > 0 && block !== lastBlock) text += '\n'
    lastBlock = block
    pieces.push({ node: t, at: text.length })
    text += t.data
  }
  return { text, pieces }
}

/** Узел и смещение в нём для позиции pos строки (pos внутри или на конце узла). */
function locate(pieces: Piece[], pos: number, end: boolean): { node: Text; offset: number } {
  let lo = 0
  let hi = pieces.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    // Конец совпадения на стыке узлов — в конце предыдущего, начало — в начале следующего.
    if (end ? pieces[mid].at < pos : pieces[mid].at <= pos) lo = mid
    else hi = mid - 1
  }
  const p = pieces[lo]
  return { node: p.node, offset: Math.min(pos - p.at, p.node.data.length) }
}

/** Все совпадения query в ленте (по порядку). Элемент ленты — прямой потомок root. */
export function findRanges(root: Element, query: string, caseSensitive = false): Range[] {
  if (!query) return []
  const q = caseSensitive ? query : foldCase(query)
  const out: Range[] = []
  for (const el of Array.from(root.children)) {
    if (el.matches(SKIP)) continue
    const { text, pieces } = collect(el)
    if (pieces.length === 0) continue
    const hay = caseSensitive ? text : foldCase(text)
    for (let i = hay.indexOf(q); i >= 0; i = hay.indexOf(q, i + q.length)) {
      const s = locate(pieces, i, false)
      const e = locate(pieces, i + q.length, true)
      const r = root.ownerDocument.createRange()
      r.setStart(s.node, s.offset)
      r.setEnd(e.node, e.offset)
      out.push(r)
    }
  }
  return out
}

/** Индекс первого совпадения, видного в области прокрутки (или ниже неё); иначе последнего. */
export function firstVisible(ranges: Range[], viewport: Element): number {
  if (ranges.length === 0) return -1
  const top = viewport.getBoundingClientRect().top
  for (let i = 0; i < ranges.length; i++) {
    const r = rectOf(ranges[i])
    if (!r || r.bottom >= top) return i
  }
  return ranges.length - 1
}

function rectOf(r: Range): DOMRect | null {
  return typeof r.getBoundingClientRect === 'function' ? r.getBoundingClientRect() : null
}

/** Событие «развернуть свёрнутое» — на .ans-body.clipped, когда к нему ведёт поиск. */
export const REVEAL_EVENT = 'kv-reveal'

/** Прокрутить viewport так, чтобы совпадение было видно (с запасом сверху). */
export function scrollToRange(r: Range, viewport: HTMLElement): void {
  // Совпадение в свёрнутом длинном ответе — сначала развернуть его (AssistantCard слушает REVEAL_EVENT).
  r.startContainer.parentElement?.closest('.ans-body.clipped')?.dispatchEvent(new Event(REVEAL_EVENT))
  const rect = rectOf(r)
  if (!rect || (rect.width === 0 && rect.height === 0)) {
    r.startContainer.parentElement?.scrollIntoView?.({ block: 'center' })
    return
  }
  const box = viewport.getBoundingClientRect()
  const pad = 24
  if (rect.top < box.top + pad || rect.bottom > box.bottom - pad) {
    viewport.scrollTop += rect.top - box.top - viewport.clientHeight / 3
  }
}

// Подсветки общие на документ: у каждой панели свои диапазоны, в реестр — объединение.
const byPane = new Map<string, { all: Range[]; current: Range | null }>()

interface HighlightLike {
  add(r: Range): void
}
type HighlightCtor = new (...ranges: Range[]) => HighlightLike
interface Registry {
  set(name: string, h: HighlightLike): void
  delete(name: string): void
}

function registry(): { reg: Registry; Ctor: HighlightCtor } | null {
  const css = (globalThis as { CSS?: { highlights?: Registry } }).CSS
  const Ctor = (globalThis as { Highlight?: HighlightCtor }).Highlight
  return css?.highlights && Ctor ? { reg: css.highlights, Ctor } : null
}

/** Сколько совпадений подсвечивается (счётчик «N из M» считает все). */
export const MAX_HIGHLIGHTS = 5000

/**
 * Диапазоны добавляются по одному: `new Highlight(...ranges)` при десятках тысяч совпадений
 * упирается в лимит аргументов JavaScriptCore (RangeError).
 */
function highlight(Ctor: HighlightCtor, ranges: Range[]): HighlightLike {
  const h = new Ctor()
  const n = Math.min(ranges.length, MAX_HIGHLIGHTS)
  for (let i = 0; i < n; i++) h.add(ranges[i])
  return h
}

function sync(): void {
  const api = registry()
  if (!api) return
  const all: Range[] = []
  const cur: Range[] = []
  for (const v of byPane.values()) {
    for (const r of v.all) if (r !== v.current) all.push(r)
    if (v.current) cur.push(v.current)
  }
  if (all.length) api.reg.set(FIND_HIGHLIGHT, highlight(api.Ctor, all))
  else api.reg.delete(FIND_HIGHLIGHT)
  if (cur.length) api.reg.set(FIND_CURRENT, highlight(api.Ctor, cur))
  else api.reg.delete(FIND_CURRENT)
}

export function setPaneHighlights(paneId: string, all: Range[], current: Range | null): void {
  byPane.set(paneId, { all, current })
  sync()
}

export function clearPaneHighlights(paneId: string): void {
  if (byPane.delete(paneId)) sync()
}

/** Для тестов: что сейчас подсвечено у панели. */
export function paneHighlights(paneId: string): { all: Range[]; current: Range | null } | undefined {
  return byPane.get(paneId)
}
