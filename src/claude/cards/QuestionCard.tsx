// Вопрос агента (AskUserQuestion) в ленте: пока ждёт ответа — тихая строка «? Ждёт ответа: …»
// (сам вопрос — в блоке над строкой ввода, QuestionPrompt); ответили — свёрнутая карточка «✓ Ответ: …».
import { memo } from 'react'
import type { Agent, FeedClaudeItem } from '../reducer'
import { agentSignature } from './AssistantCard'

type QuestionItem = Extract<FeedClaudeItem, { type: 'question' }>

export const WAIT_PREFIX = '? Ждёт ответа: '

export const QuestionCard = memo(function QuestionCard({ item, agent, id }: { item: QuestionItem; agent?: Agent; id?: string }) {
  const total = item.questions.length
  if (!item.done) {
    return (
      <div className="cl-note q-wait" data-item-id={id}>
        {WAIT_PREFIX}
        {item.questions.map((q) => q.question).join(' · ')}
      </div>
    )
  }
  return (
    <div className="card qcard done" data-item-id={id}>
      <div className="who">? Вопрос · {agentSignature(agent)}</div>
      {item.answers.map((a, i) => (
        <div className="q-ans" key={i}>
          ✓ {total > 1 ? `${item.questions[i].header || item.questions[i].question}: ` : 'Ответ: '}
          <b>{a}</b>
        </div>
      ))}
    </div>
  )
})
