import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { Agent } from '../reducer'
import { questionItem } from '../fixtures/questionItem'
import { CANCELLED, QuestionCard, WAIT_PREFIX } from './QuestionCard'

const agent = { id: 'main', name: 'Главный', model: 'claude-opus-5-5' } as Agent

describe('QuestionCard (лента)', () => {
  it('пока ждёт — строка «? Ждёт ответа: …»', () => {
    const { container } = render(<QuestionCard id="q1" item={questionItem()} agent={agent} />)
    const el = container.querySelector('[data-item-id="q1"]')!
    expect(el).toHaveClass('cl-note', 'q-wait')
    expect(el.textContent).toBe(WAIT_PREFIX + 'Какой цвет? · Что ещё?')
  })

  it('отменён — строка «✕ Вопрос отменён»', () => {
    const { container } = render(<QuestionCard item={questionItem({ cancelled: true })} />)
    expect(container.textContent).toBe(CANCELLED)
    expect(CANCELLED).toBe('✕ Вопрос отменён — Claude завершился')
  })

  it('отвечен — свёрнутая карточка с ответами', () => {
    const { container } = render(<QuestionCard item={questionItem({ done: true, step: 2, answers: ['Blue', 'A, B'] })} agent={agent} />)
    expect(container.querySelector('.qcard .who')!.textContent).toBe('? Вопрос · Главный · Opus 5.5')
    expect([...container.querySelectorAll('.q-ans')].map((a) => a.textContent)).toEqual(['✓ Цвет: Blue', '✓ Опции: A, B'])
    const one = render(<QuestionCard item={questionItem({ questions: [questionItem().questions[0]], done: true, step: 0, answers: ['Red'] })} />)
    expect(one.container.querySelector('.q-ans')!.textContent).toBe('✓ Ответ: Red')
  })
})
