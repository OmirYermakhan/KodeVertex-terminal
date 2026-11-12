// Файл не Feed.tsx: на регистронезависимой ФС macOS он конфликтует с feed.ts (модель ленты).
import { forwardRef, Fragment, type ReactNode } from 'react'
import type { ClaudeItem, FeedItem, ShellBlock } from './feed'
import { ShellBlockView } from './ShellBlockView'

/** Временный вид Claude-элемента; настоящие карточки — Task 6 (подменяется через renderClaude). */
export function ClaudeItemView({ item }: { item: ClaudeItem }) {
  const it = item.item
  const text = 'text' in it ? it.text : it.type === 'action' ? it.title : ''
  return (
    <div className={`claude-item claude-${it.type}`} data-item-id={item.id}>
      {text}
    </div>
  )
}

export interface FeedProps {
  items: FeedItem[]
  selectedId: string | null
  /** Живой терминал для running-блока (null — блок без терминала, например при alt screen). */
  renderLive: (block: ShellBlock) => ReactNode
  renderClaude?: (item: ClaudeItem) => ReactNode
  onScroll?: () => void
  /** Слот для xterm, пока он не показан (держит ширину блока, см. TerminalPane). */
  park?: ReactNode
}

export const Feed = forwardRef<HTMLDivElement, FeedProps>(function Feed(
  { items, selectedId, renderLive, renderClaude = (it) => <ClaudeItemView item={it} />, onScroll, park },
  ref,
) {
  return (
    <div className="feed" ref={ref} onScroll={onScroll}>
      {items.map((it) =>
        it.kind === 'shell' ? (
          <ShellBlockView
            key={it.id}
            block={it}
            selected={it.id === selectedId}
            live={it.running ? renderLive(it) : undefined}
          />
        ) : (
          <Fragment key={it.id}>{renderClaude(it)}</Fragment>
        ),
      )}
      {park}
    </div>
  )
})
