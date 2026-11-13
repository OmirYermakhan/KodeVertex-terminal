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

export const Feed = forwardRef<HTMLDivElement, FeedProps>(function Feed(
  { items, selectedId, renderLive, agents = NO_AGENTS, renderClaude, onScroll, park, onAttach, onCopy, onRepeat, onAsk, onRead, editable, onEdit, editingId },
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
  const scrolled = () => {
    onScroll?.()
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      if (own.current) markStuck(own.current)
    })
  }
  useLayoutEffect(() => {
    if (own.current) markStuck(own.current)
  }, [items])
  useLayoutEffect(() => () => cancelAnimationFrame(frame.current), [])
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
      {items.length === 0 && <EmptyHint />}
      {park}
    </div>
  )
})
