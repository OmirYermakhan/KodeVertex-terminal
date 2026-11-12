import { describe, expect, it } from 'vitest'
import { allowResponse, answerResponse, parsePermissionRequest, questionKey } from './questions'

const input = {
  questions: [
    { question: 'Какой цвет?', header: 'Цвет', multiSelect: false, options: [{ label: 'Red', description: 'Красный' }, { label: 'Blue', description: 'Синий' }] },
    { question: 'Что добавить?', header: 'Опции', multiSelect: true, options: [{ label: 'A', description: '' }, { label: 'B', description: 'бэ' }] },
  ],
}
const req = (tool: string, inp: unknown = input) => ({
  type: 'control_request',
  request_id: 'r1',
  request: { subtype: 'can_use_tool', tool_name: tool, input: inp, tool_use_id: 'tu1' },
})

describe('parsePermissionRequest', () => {
  it('AskUserQuestion — вопросы с вариантами', () => {
    const r = parsePermissionRequest(req('AskUserQuestion'))!
    expect(r.kind).toBe('ask')
    if (r.kind !== 'ask') return
    expect(r.requestId).toBe('r1')
    expect(r.toolUseId).toBe('tu1')
    expect(r.questions).toHaveLength(2)
    expect(r.questions[1]).toEqual({ question: 'Что добавить?', header: 'Опции', multiSelect: true, options: [{ label: 'A', description: '' }, { label: 'B', description: 'бэ' }] })
  })

  it('другой инструмент или вопрос без вариантов — разрешить как есть', () => {
    expect(parsePermissionRequest(req('Bash', { command: 'ls' }))).toEqual({ kind: 'allow', requestId: 'r1', input: { command: 'ls' } })
    expect(parsePermissionRequest(req('AskUserQuestion', { questions: [] }))!.kind).toBe('allow')
    expect(parsePermissionRequest(req('AskUserQuestion', { questions: 'x' }))!.kind).toBe('allow')
  })

  it('чужие строки — null', () => {
    expect(parsePermissionRequest({ type: 'control_request', request_id: 'r', request: { subtype: 'interrupt' } })).toBeNull()
    expect(parsePermissionRequest({ type: 'assistant' })).toBeNull()
    expect(parsePermissionRequest('мусор')).toBeNull()
  })
})

describe('ответы', () => {
  it('answerResponse: исходный ввод + answers по тексту вопроса; несколько вариантов — через запятую', () => {
    expect(answerResponse(input, ['Blue', 'A, B'])).toEqual({
      behavior: 'allow',
      updatedInput: { ...input, answers: { 'Какой цвет?': 'Blue', 'Что добавить?': 'A, B' } },
    })
  })
  it('allowResponse — без изменений ввода', () => {
    expect(allowResponse({ command: 'ls' })).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } })
  })
})

describe('questionKey', () => {
  const single = { question: 'Цвет?', header: 'Цвет', multiSelect: false, options: [{ label: 'Red', description: '' }, { label: 'Blue', description: '' }] }
  const multi = { ...single, multiSelect: true }
  const s0 = { cursor: 0, checked: [] as number[] }

  it('↑↓ по кругу с «Свой ответ…», цифры — к строке', () => {
    expect(questionKey(s0, single, 'ArrowDown').state.cursor).toBe(1)
    expect(questionKey(s0, single, 'ArrowUp').state.cursor).toBe(2)
    expect(questionKey({ cursor: 2, checked: [] }, single, 'ArrowDown').state.cursor).toBe(0)
    expect(questionKey(s0, single, '2').state.cursor).toBe(1)
    expect(questionKey(s0, single, '3').state.cursor).toBe(2)
    expect(questionKey(s0, single, '4').handled).toBe(false)
  })

  it('↵: вариант; «Свой ответ…» — custom; esc — к вводу', () => {
    expect(questionKey({ cursor: 1, checked: [] }, single, 'Enter').action).toEqual({ kind: 'answer', text: 'Blue' })
    expect(questionKey({ cursor: 2, checked: [] }, single, 'Enter').action).toEqual({ kind: 'custom' })
    expect(questionKey(s0, single, 'Escape').action).toEqual({ kind: 'leave' })
  })

  it('несколько ответов: пробел отмечает, ↵ — отмеченные через запятую (ничего — строка под курсором)', () => {
    const a = questionKey(s0, multi, ' ').state
    expect(a.checked).toEqual([0])
    const b = questionKey({ ...a, cursor: 1 }, multi, ' ').state
    expect(questionKey(b, multi, 'Enter').action).toEqual({ kind: 'answer', text: 'Red, Blue' })
    expect(questionKey(questionKey(b, multi, ' ').state, multi, 'Enter').action).toEqual({ kind: 'answer', text: 'Red' })
    expect(questionKey({ cursor: 1, checked: [] }, multi, 'Enter').action).toEqual({ kind: 'answer', text: 'Blue' })
    // В одиночном вопросе пробел не отмечает.
    expect(questionKey(s0, single, ' ').state.checked).toEqual([])
  })
})

describe('рекомендуемый вариант', () => {
  it('метка по подписи или описанию, хвост убирается из подписи', async () => {
    const { isRecommended, displayLabel } = await import('./questions')
    expect(isRecommended({ label: 'Postgres (Recommended)', description: '' })).toBe(true)
    expect(isRecommended({ label: 'Redis', description: 'Рекомендуется для кэша' })).toBe(true)
    expect(isRecommended({ label: 'SQLite', description: 'просто' })).toBe(false)
    expect(displayLabel('Postgres (Recommended)')).toBe('Postgres')
    expect(displayLabel('Да (рекомендуется)')).toBe('Да')
    expect(displayLabel('Redis')).toBe('Redis')
  })
})
