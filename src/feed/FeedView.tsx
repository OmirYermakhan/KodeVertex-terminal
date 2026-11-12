// Файл не Feed.tsx: на регистронезависимой ФС macOS он конфликтует с feed.ts (модель ленты).
import { forwardRef, Fragment, type ReactNode } from 'react'
import { ClaudeCard } from '../claude/cards/ClaudeCard'
import type { Agent } from '../claude/reducer'
import type { ClaudeItem, FeedItem, ShellBlock } from './feed'
import { ShellBlockView } from './ShellBlockView'

const NO_AGENTS: readonly Agent[] = []

function agentOf(agents: readonly Agent[], it: ClaudeItem): Agent | undefined {
  const x = it.item
  return x.type === 'assistant' || x.type === 'action' || x.type === 'question' ? agents.find((a) => a.id === x.agentId) : undefined
}

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
}

export const Feed = forwardRef<HTMLDivElement, FeedProps>(function Feed(
  { items, selectedId, renderLive, agents = NO_AGENTS, renderClaude, onScroll, park, onAttach, onCopy },
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
            onAttach={onAttach}
            onCopy={onCopy}
          />
        ) : renderClaude ? (
          <Fragment key={it.id}>{renderClaude(it)}</Fragment>
        ) : (
          <ClaudeCard key={it.id} item={it} agent={agentOf(agents, it)} selected={it.id === selectedId} onAttach={onAttach} onCopy={onCopy} />
        ),
      )}
      {park}
    </div>
  )
})
