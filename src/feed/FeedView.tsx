// Файл не Feed.tsx: на регистронезависимой ФС macOS он конфликтует с feed.ts (модель ленты).
import { forwardRef, Fragment, useCallback, useLayoutEffect, useRef, type ReactNode } from 'react'
import { ClaudeCard } from '../claude/cards/ClaudeCard'
import { ErrorBoundary } from '../diag/ErrorBoundary'
import { agentOf, type Agent } from '../claude/reducer'
import type { ClaudeItem, FeedItem, ShellBlock } from './feed'
import { ShellBlockView } from './ShellBlockView'
import { EmptyHint } from './EmptyHint'

const NO_AGENTS: readonly Agent[] = []

export interface FeedProps {
  items: FeedItem[]
  selectedId: string | null
  /** Живой терминал для running-блока (null — блок без терминала, например при alt screen). */
  renderLive: (block: ShellBlock) => ReactNode
  /** Агенты сессии — для подписи «Имя · Модель» на карточках. */
  agents?: readonly Agent[]
  /** Каталог Claude-сессии: пути в карточках правок — относительно него. */
  cwd?: string | null
  /** Вид Claude-элемента; по умолчанию — карточки ClaudeCard. */
  renderClaude?: (item: ClaudeItem) => ReactNode
  onScroll?: () => void
  /** Слот для xterm, пока он не показан (держит ширину блока, см. TerminalPane). */
  park?: ReactNode
  /** Блок — значком в строку ввода («⌘L в сообщение»). */
  onAttach?(id: string): void
  onCopy?(id: string): void
  /** Блок: «Повторить» (передаётся, только когда оболочка в простое) и «Спросить Claude». */
  onRepeat?(id: string): void
  onAsk?(id: string): void
  /** Ответ — в режиме чтения. */
  onRead?(id: string): void
  /** Сообщения «Вы», которые можно изменить (id ленты), и «✎ Изменить». */
  editable?: ReadonlySet<string>
  onEdit?(id: string): void
  /** Сообщение, которое сейчас правится в строке ввода. */
  editingId?: string | null
  /** Строка ввода в режиме Claude — подсказка пустой ленты про этот режим. */
  claudeMode?: boolean
}

/**
 * Заголовок «❯ команда» длинного блока прилипает к верху ленты (CSS position: sticky);
 * прилипшему — класс .stuck (тонкая линия снизу). Блоки идут по порядку: дальше верхнего края не смотрим.
 */
export function markStuck(feed: HTMLElement): void {
  const top = feed.getBoundingClientRect().top
  for (const el of Array.from(feed.querySelectorAll<HTMLElement>('.bh.stuck'))) el.classList.remove('stuck')
  for (const blk of Array.from(feed.children) as HTMLElement[]) {
    if (!blk.classList.contains('blk')) continue
    const r = blk.getBoundingClientRect()
    if (r.top >= top) break
    const bh = blk.querySelector<HTMLElement>(':scope > .bh')
    if (bh && r.bottom > top + bh.offsetHeight) {
      bh.classList.add('stuck')
      break
    }
  }
}

/** Довести до конца анимации появления у детей ленты (без Web Animations — ничего). */
export function finishAppear(feed: HTMLElement | null): void {
  if (!feed) return
  for (const el of Array.from(feed.children)) {
    if (typeof el.getAnimations !== 'function') return
    for (const a of el.getAnimations()) a.finish()
  }
}

export const Feed = forwardRef<HTMLDivElement, FeedProps>(function Feed(
  { items, selectedId, renderLive, agents = NO_AGENTS, cwd, renderClaude, onScroll, park, onAttach, onCopy, onRepeat, onAsk, onRead, editable, onEdit, editingId, claudeMode = false },
  ref,
) {
  const own = useRef<HTMLDivElement | null>(null)
  const setRef = useCallback(
    (el: HTMLDivElement | null) => {
      own.current = el
      if (typeof ref === 'function') ref(el)
      else if (ref) ref.current = el
    },
    [ref],
  )
  const frame = useRef(0)
  // Пересчёт прилипшего заголовка — не чаще кадра; только на прокрутке, смене размера и числа блоков
  // (кусок стрима ответа Claude его не вызывает).
  const restick = useCallback(() => {
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      if (own.current) markStuck(own.current)
    })
  }, [])
  const scrolled = () => {
    onScroll?.()
    restick()
  }
  const blocks = items.reduce((n, it) => (it.kind === 'shell' ? n + 1 : n), 0)
  useLayoutEffect(restick, [blocks, restick])
  const ro = useRef<ResizeObserver | null>(null)
  useLayoutEffect(() => {
    const f = own.current
    const r = f && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(restick) : null
    r?.observe(f!)
    ro.current = r
    return () => {
      r?.disconnect()
      ro.current = null
      cancelAnimationFrame(frame.current)
    }
  }, [restick])
  // И размер самих блоков: вывод вырос или заморозился без прокрутки — линия .stuck не устаревает.
  // Карточки Claude не наблюдаем: стрим ответа пересчёт не вызывает.
  useLayoutEffect(() => {
    const f = own.current
    const r = ro.current
    if (!f || !r) return
    const blks = Array.from(f.children).filter((c) => c.classList.contains('blk'))
    for (const b of blks) r.observe(b)
    return () => {
      for (const b of blks) r.unobserve(b)
    }
  }, [blocks])
  // Элементы, что уже есть при монтировании (восстановленная сессия), появляются без анимации:
  // CSS-анимацию появления у них сразу доводим до конца, до первой отрисовки.
  useLayoutEffect(() => {
    finishAppear(own.current)
  }, [])
  return (
    <div className="feed" ref={setRef} onScroll={scrolled}>
      {items.map((it) => (
        // Сбой одной карточки (необычный ответ, вывод инструмента) не роняет ленту и окно.
        // resetKey: обновлённый элемент (стрим ответа) пробует отрисоваться снова.
        <ErrorBoundary key={it.id} name={it.kind === 'shell' ? 'блок' : 'карточку'} resetKey={it}>
          {it.kind === 'shell' ? (
            <ShellBlockView
              block={it}
              selected={it.id === selectedId}
              live={it.running ? renderLive(it) : undefined}
              onAttach={onAttach}
              onCopy={onCopy}
              onRepeat={onRepeat}
              onAsk={onAsk}
            />
          ) : renderClaude ? (
            <Fragment>{renderClaude(it)}</Fragment>
          ) : (
            <ClaudeCard
              item={it}
              agent={agentOf(agents, it.item)}
              agents={it.item.type === 'replaced' ? agents : undefined}
              cwd={cwd}
              selected={it.id === selectedId}
              onAttach={onAttach}
              onCopy={onCopy}
              onRead={onRead}
              onEdit={editable?.has(it.id) ? onEdit : undefined}
              editing={it.id === editingId}
            />
          )}
        </ErrorBoundary>
      ))}
      {/* Пустая лента — подсказка с клавишами; исчезает с первым блоком или карточкой. */}
      {items.length === 0 && <EmptyHint claude={claudeMode} />}
      {park}
    </div>
  )
})
