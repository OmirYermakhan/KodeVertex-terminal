import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ARM_MS } from './PermissionPrompt'
import type { Agent } from './reducer'
import { OWN_ANSWER, QuestionPrompt, RECOMMENDED_TAG, SEND_ANSWERS, promptKeys } from './QuestionPrompt'
import { questionItem } from './fixtures/questionItem'

const agent = { id: 'main', name: 'Главный', model: 'claude-opus-5-5' } as Agent

const arm = () => act(() => void vi.advanceTimersByTime(ARM_MS))

/** armed — сразу после отсчёта ARM_MS (как будто вопрос висит давно). */
function setup(item = questionItem(), armed = true) {
  const h = { onAnswer: vi.fn(), onStep: vi.fn(), onSubmit: vi.fn(), onLeave: vi.fn() }
  const r = render(<QuestionPrompt item={item} agent={agent} {...h} />)
  const box = r.container.querySelector('.aprompt') as HTMLElement
  if (armed) arm()
  return { ...r, h, box, key: (k: string) => fireEvent.keyDown(box, { key: k }) }
}

describe('QuestionPrompt', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it(`первые ${ARM_MS} мс ↵ и щелчок по варианту не отвечают; набор своего ответа — сразу; новый вопрос — отсчёт заново`, () => {
    const one = questionItem({ questions: [questionItem().questions[0]] })
    const { key, h, box, rerender } = setup(one, false)
    expect(box.querySelector('.q-opts')).toHaveClass('p-wait')
    key('Enter')
    fireEvent.click(screen.getAllByRole('option')[1])
    act(() => void vi.advanceTimersByTime(ARM_MS - 1))
    key('Enter')
    expect(h.onAnswer).not.toHaveBeenCalled()
    // Своё — печатается и отправляется сразу: случайным ↵ его не набрать.
    key('M')
    const input = box.querySelector('input.q-own') as HTMLInputElement
    expect(input.value).toBe('M')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(h.onAnswer).toHaveBeenCalledWith(0, 'M')
    h.onAnswer.mockClear()
    act(() => void vi.advanceTimersByTime(1))
    expect(box.querySelector('.q-opts')).not.toHaveClass('p-wait')
    const blue = screen.getAllByRole('option')[1]
    fireEvent.mouseDown(blue)
    expect(h.onAnswer).not.toHaveBeenCalled()
    fireEvent.click(blue)
    expect(h.onAnswer).toHaveBeenCalledWith(0, 'Blue')
    // Следующий вопрос в том же блоке — снова ждёт.
    rerender(<QuestionPrompt item={{ ...one, requestId: 'next' }} agent={agent} {...h} />)
    h.onAnswer.mockClear()
    key('1')
    key('Enter')
    expect(h.onAnswer).not.toHaveBeenCalled()
    arm()
    key('Enter')
    expect(h.onAnswer).toHaveBeenCalledWith(0, 'Red (Recommended)')
  })

  it('заголовок, «1 из 2», вкладки, вопрос; варианты с описанием и меткой «рекомендуется»', () => {
    const { box } = setup()
    expect(box.querySelector('.ap-who')!.textContent).toBe('? Вопрос · Главный · Opus 5.5')
    expect(box.querySelector('.ap-aside')!.textContent).toBe('1 из 2')
    expect([...box.querySelectorAll('.q-tab')].map((t) => t.textContent)).toEqual(['1 Цвет', '2 Опции', SEND_ANSWERS])
    expect(box.querySelector('.q-text')!.textContent).toBe('Какой цвет?')
    const rows = screen.getAllByRole('option')
    expect(rows.slice(0, 2).map((r) => r.querySelector('.q-l')!.textContent)).toEqual([`Red${RECOMMENDED_TAG}`, 'Blue'])
    expect((rows[2].querySelector('input.q-own') as HTMLInputElement).placeholder).toBe(OWN_ANSWER)
    expect(rows[0].querySelector('.q-d')!.textContent).toBe('Красный')
    expect(box.querySelector('.ap-keys')!.textContent).toBe(promptKeys(true, false, false))
  })

  it('клавиши: 2 ↵ — ответ на вопрос 1; →/← — вкладки; esc', () => {
    const { key, h } = setup()
    key('2')
    key('Enter')
    expect(h.onAnswer).toHaveBeenCalledWith(0, 'Blue')
    key('ArrowRight')
    expect(h.onStep).toHaveBeenCalledWith(1)
    key('ArrowLeft')
    expect(h.onStep).toHaveBeenLastCalledWith(0)
    key('Escape')
    expect(h.onLeave).toHaveBeenCalled()
  })

  it('свой ответ: поле в строке «Свой ответ…»; буква на любой строке — туда; цифры и пробел — текст; ↵ — ответ', () => {
    const { key, h, box } = setup()
    box.focus()
    const input = box.querySelector('input.q-own') as HTMLInputElement
    key('3')
    expect(document.activeElement).toBe(input)
    key('ArrowUp')
    expect(document.activeElement).toBe(box)
    key('M')
    expect(document.activeElement).toBe(input)
    expect(input.value).toBe('M')
    fireEvent.change(input, { target: { value: 'MySQL 8' } })
    fireEvent.keyDown(input, { key: '1' })
    fireEvent.keyDown(input, { key: ' ' })
    expect(h.onAnswer).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(h.onAnswer).toHaveBeenCalledWith(0, 'MySQL 8')
  })

  it('свой ответ: пустое поле ↵ не отправляет; прежний свой ответ — снова в поле', () => {
    const empty = setup()
    const input = empty.box.querySelector('input.q-own') as HTMLInputElement
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(empty.h.onAnswer).not.toHaveBeenCalled()
    empty.unmount()
    const again = setup(questionItem({ answers: ['Зелёный', ''] }))
    expect((again.box.querySelector('input.q-own') as HTMLInputElement).value).toBe('Зелёный')
    expect(again.box.querySelector('.q-row.sel input.q-own')).not.toBeNull()
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
    expect(miss.box.querySelector('.ap-aside')!.textContent).toBe('Отправка')
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
