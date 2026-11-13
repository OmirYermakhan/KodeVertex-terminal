import { memo, useState } from 'react'
import type { ClaudeItem } from '../../feed/feed'
import { agentOf, messagesLabel, type Agent, type FeedClaudeItem } from '../reducer'
import { ActionCard } from './ActionCard'
import { AssistantCard } from './AssistantCard'
import { ErrorCard } from './ErrorCard'
import { PermissionCard } from './PermissionCard'
import { QuestionCard } from './QuestionCard'
import { SessionNote } from './SessionNote'
import { SummaryCard } from './SummaryCard'
import { UserBubble } from './UserBubble'

export const OLD_VARIANT = '↺ Прежний вариант'

/**
 * Прежний вариант разговора после правки сообщения: приглушённая строка на месте изменённого
 * пузыря; клик или ↵ раскрывает прежние элементы (только для чтения — без панелек действий).
 */
function ReplacedRow({ id, items, count, agents }: { id: string; items: FeedClaudeItem[]; count: number; agents?: readonly Agent[] }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={'cl-old' + (open ? ' open' : '')} data-item-id={id}>
      <button type="button" className="cl-old-row" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {OLD_VARIANT} · {messagesLabel(count)}
        <span className="cl-old-keys">{open ? 'свернуть' : 'показать'}</span>
      </button>
      {open && (
        <div className="cl-old-items">
          {items.map((x, i) => (
            <ClaudeCard key={i} item={{ kind: 'claude', id: `${id}-old-${i}`, item: x }} agent={agentOf(agents, x)} agents={agents} />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Карточка Claude-элемента ленты; agent — агент для подписи (лента находит его по agentId).
 * Отдельный объект агента, а не весь список: обновление другого агента карточку не перерисовывает.
 */
export const ClaudeCard = memo(function ClaudeCard({
  item,
  agent,
  selected,
  onAttach,
  onCopy,
  onRead,
  onEdit,
  editing,
  agents,
}: {
  item: ClaudeItem
  agent?: Agent
  selected?: boolean
  /** Пузырь «Вы»: «✎ Изменить» (только у сообщений, которые можно переписать). */
  onEdit?(id: string): void
  /** Пузырь правится в строке ввода. */
  editing?: boolean
  /** Агенты сессии — для карточек внутри «Прежнего варианта». */
  agents?: readonly Agent[]
  /** Ответ — значком в строку ввода / копировать (панелька над карточкой). */
  onAttach?(id: string): void
  onCopy?(id: string): void
  onRead?(id: string): void
}) {
  const it = item.item
  switch (it.type) {
    case 'user':
      return <UserBubble id={item.id} text={it.text} tokens={it.tokens} selected={selected} editing={editing} onEdit={onEdit} />
    case 'assistant':
      return <AssistantCard id={item.id} agent={agent} text={it.text} streaming={it.streaming} selected={selected} onAttach={onAttach} onCopy={onCopy} onRead={onRead} />
    case 'action':
      // Вопрос агента показывает своя карточка (question), действие «AskUserQuestion» не дублируем.
      if (it.tool === 'AskUserQuestion') return null
      return <ActionCard id={item.id} item={it} agent={agent} />
    case 'permission':
      return <PermissionCard id={item.id} item={it} />
    case 'question':
      return <QuestionCard id={item.id} item={it} agent={agent} />
    case 'summary':
      return <SummaryCard id={item.id} text={it.text} durationMs={it.durationMs} costUsd={it.costUsd} isError={it.isError} />
    case 'error':
      return <ErrorCard id={item.id} text={it.text} />
    case 'session':
      return <SessionNote id={item.id} cwd={it.cwd} mode={it.mode} />
    case 'replaced':
      return <ReplacedRow id={item.id} items={it.items} count={it.count} agents={agents} />
    case 'gone':
      return null
    case 'note':
      return (
        <div className="cl-note" data-item-id={item.id}>
          {it.text}
        </div>
      )
  }
})
