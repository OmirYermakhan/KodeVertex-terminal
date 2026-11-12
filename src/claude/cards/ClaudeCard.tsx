import { memo } from 'react'
import type { ClaudeItem } from '../../feed/feed'
import type { Agent } from '../reducer'
import { ActionCard } from './ActionCard'
import { AssistantCard } from './AssistantCard'
import { ErrorCard } from './ErrorCard'
import { SessionNote } from './SessionNote'
import { SummaryCard } from './SummaryCard'
import { UserBubble } from './UserBubble'

/**
 * Карточка Claude-элемента ленты; agent — агент для подписи (лента находит его по agentId).
 * Отдельный объект агента, а не весь список: обновление другого агента карточку не перерисовывает.
 */
export const ClaudeCard = memo(function ClaudeCard({ item, agent }: { item: ClaudeItem; agent?: Agent }) {
  const it = item.item
  switch (it.type) {
    case 'user':
      return <UserBubble id={item.id} text={it.text} />
    case 'assistant':
      return <AssistantCard id={item.id} agent={agent} text={it.text} streaming={it.streaming} />
    case 'action':
      return <ActionCard id={item.id} item={it} agent={agent} />
    case 'summary':
      return <SummaryCard id={item.id} text={it.text} durationMs={it.durationMs} costUsd={it.costUsd} isError={it.isError} />
    case 'error':
      return <ErrorCard id={item.id} text={it.text} />
    case 'session':
      return <SessionNote id={item.id} cwd={it.cwd} />
  }
})
