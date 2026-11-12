import { memo } from 'react'
import { modelLabel } from '../labels'
import { Markdown } from '../Markdown'
import type { Agent } from '../reducer'

/** «Имя агента · Модель»; без агента — «Claude». */
export function agentSignature(agent: Agent | undefined): string {
  if (!agent) return 'Claude'
  return agent.model ? `${agent.name} · ${modelLabel(agent.model)}` : agent.name
}

export const isFable = (agent: Agent | undefined): boolean => !!agent?.model?.toLowerCase().includes('fable')

/** Ответ агента: карточка с полосой слева (макет 04, .card); у Fable — золото. */
export const AssistantCard = memo(function AssistantCard({
  agent,
  text,
  streaming,
  id,
  selected,
}: {
  agent: Agent | undefined
  text: string
  streaming: boolean
  id?: string
  /** Выбран ⌘↑ (⌘L вложит его в сообщение). */
  selected?: boolean
}) {
  return (
    <div className={(isFable(agent) ? 'card fable' : 'card') + (selected ? ' sel' : '')} data-item-id={id}>
      <div className="who">{agentSignature(agent)}</div>
      <Markdown text={text} streaming={streaming} />
    </div>
  )
})
