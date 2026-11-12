import { memo } from 'react'
import type { ClaudeItem } from '../../feed/feed'
import type { Agent } from '../reducer'
import { ActionCard } from './ActionCard'
import { AssistantCard } from './AssistantCard'
import { ErrorCard } from './ErrorCard'
import { SummaryCard } from './SummaryCard'
import { UserBubble } from './UserBubble'

/** Карточка Claude-элемента ленты; агент для подписи ищется по agentId. */
export const ClaudeCard = memo(function ClaudeCard({ item, agents }: { item: ClaudeItem; agents: readonly Agent[] }) {
  const it = item.item
  switch (it.type) {
    case 'user':
      return <UserBubble id={item.id} text={it.text} />
    case 'assistant':
      return <AssistantCard id={item.id} agent={agents.find((a) => a.id === it.agentId)} text={it.text} streaming={it.streaming} />
    case 'action':
      return <ActionCard id={item.id} item={it} agent={agents.find((a) => a.id === it.agentId)} />
    case 'summary':
      return <SummaryCard id={item.id} text={it.text} durationMs={it.durationMs} costUsd={it.costUsd} isError={it.isError} />
    case 'error':
      return <ErrorCard id={item.id} text={it.text} />
  }
})
