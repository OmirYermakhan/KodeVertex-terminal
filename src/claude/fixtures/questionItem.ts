// Вопрос агента для тестов карточки и блока над строкой ввода.
import type { FeedClaudeItem } from '../reducer'

type Q = Extract<FeedClaudeItem, { type: 'question' }>
export const questionItem = (over: Partial<Q> = {}): Q => ({
  type: 'question',
  requestId: 'rq',
  toolUseId: 't',
  agentId: 'main',
  input: {},
  step: 0,
  answers: [],
  done: false,
  questions: [
    { question: 'Какой цвет?', header: 'Цвет', multiSelect: false, options: [{ label: 'Red (Recommended)', description: 'Красный' }, { label: 'Blue', description: 'Синий' }] },
    { question: 'Что ещё?', header: 'Опции', multiSelect: true, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] },
  ],
  ...over,
})
