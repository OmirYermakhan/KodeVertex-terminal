import { memo } from 'react'
import { modelLabel } from '../labels'
import { Markdown } from '../Markdown'
import type { Agent } from '../reducer'
import { HoverActions } from '../../feed/ShellBlockView'
import { isLongAnswer } from '../reader/ReaderView'

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
  onAttach,
  onCopy,
  onRead,
}: {
  agent: Agent | undefined
  text: string
  streaming: boolean
  id?: string
  /** Выбран ⌘↑ (⌘L вложит его в сообщение). */
  selected?: boolean
  onAttach?(id: string): void
  onCopy?(id: string): void
  /** Открыть ответ в режиме чтения. */
  onRead?(id: string): void
}) {
  const long = !!onRead && !!id && isLongAnswer(text)
  return (
    <div className={(isFable(agent) ? 'card fable' : 'card') + (selected ? ' sel' : '')} data-item-id={id}>
      {!streaming && id && <HoverActions id={id} onAttach={onAttach} onCopy={onCopy} onRead={onRead} />}
      <div className="who">
        <span>{agentSignature(agent)}</span>
        {long && (
          <button type="button" className="read-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => onRead!(id!)}>
            Читать
          </button>
        )}
      </div>
      <Markdown text={text} streaming={streaming} />
    </div>
  )
})
