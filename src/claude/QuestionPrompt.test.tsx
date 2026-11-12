import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from './reducer'
import { OWN_ANSWER, QuestionPrompt, RECOMMENDED_TAG, SEND_ANSWERS, promptKeys } from './QuestionPrompt'
import { questionItem } from './fixtures/questionItem'

const agent = { id: 'main', name: 'Главный', model: 'claude-opus-5-5' } as Agent

function setup(item = questionItem()) {
  const h = { onAnswer: vi.fn(), onStep: vi.fn(), onSubmit: vi.fn(), onCustom: vi.fn(), onLeave: vi.fn() }
  const r = render(<QuestionPrompt item={item} agent={agent} {...h} />)
  const box = r.container.querySelector('.aprompt') as HTMLElement
  return { ...r, h, box, key: (k: string) => fireEvent.keyDown(box, { key: k }) }
}

describe('QuestionPrompt', () => {
  it('заголовок, «1 из 3», вкладки, вопрос; варианты с описанием и меткой «рекомендуется»', () => {
    const { box } = setup()
    expect(box.querySelector('.ap-who')!.textContent).toBe('? Вопрос · Главный · Opus 5.5')
    expect(box.querySelector('.ap-aside')!.textContent).toBe('1 из 3')
    expect([...box.querySelectorAll('.q-tab')].map((t) => t.textContent)).toEqual(['1 Цвет', '2 Опции', SEND_ANSWERS])
    expect(box.querySelector('.q-text')!.textContent).toBe('Какой цвет?')
    const rows = screen.getAllByRole('option')
    expect(rows.map((r) => r.querySelector('.q-l')!.textContent)).toEqual([`Red${RECOMMENDED_TAG}`, 'Blue', OWN_ANSWER])
    expect(rows[0].querySelector('.q-d')!.textContent).toBe('Красный')
    expect(box.querySelector('.ap-keys')!.textContent).toBe(promptKeys(true, false, false))
  })

  it('клавиши: 2 ↵ — ответ на вопрос 1; →/← — вкладки; 3 ↵ — свой ответ; esc', () => {
    const { key, h } = setup()
    key('2')
    key('Enter')
    expect(h.onAnswer).toHaveBeenCalledWith(0, 'Blue')
    key('ArrowRight')
    expect(h.onStep).toHaveBeenCalledWith(1)
    key('ArrowLeft')
    expect(h.onStep).toHaveBeenLastCalledWith(0)
    key('3')
    key('Enter')
    expect(h.onCustom).toHaveBeenCalledWith(0)
    key('Escape')
    expect(h.onLeave).toHaveBeenCalled()
  })

  it('несколько ответов: пробел отмечает, ↵ — через запятую', () => {
    const { key, h, box } = setup(questionItem({ step: 1, answers: ['Red', ''] }))
    key(' ')
    key('ArrowDown')
    key(' ')
    expect([...box.querySelectorAll('.q-box')].map((b) => b.textContent)).toEqual(['☑ ', '☑ '])
    key('Enter')
    expect(h.onAnswer).toHaveBeenCalledWith(1, 'A, B')
  })

  it('шаг «Отправить ответы»: сводка; без всех ответов ↵ ведёт к пропущенному, со всеми — отправка', () => {
    const miss = setup(questionItem({ step: 2, answers: ['Red', ''] }))
    expect(screen.getAllByRole('option').map((r) => r.textContent)).toEqual(['1.ЦветRed', '2.Опциинет ответа', `↵${SEND_ANSWERS}сначала ответьте на вопрос 2`])
    miss.key('Enter')
    expect(miss.h.onStep).toHaveBeenCalledWith(1)
    expect(miss.h.onSubmit).not.toHaveBeenCalled()
    miss.unmount()
    const ok = setup(questionItem({ step: 2, answers: ['Red', 'A'] }))
    ok.key('Enter')
    expect(ok.h.onSubmit).toHaveBeenCalled()
  })

  it('один вопрос — без вкладок и «из»', () => {
    const { box } = setup(questionItem({ questions: [questionItem().questions[0]] }))
    expect(box.querySelector('.q-tabs')).toBeNull()
    expect(box.querySelector('.ap-aside')).toBeNull()
  })
})
