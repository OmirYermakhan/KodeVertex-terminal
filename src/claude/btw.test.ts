import { describe, expect, it } from 'vitest'
import { btwQuestion, reduceBtw, type BtwAnswer } from './btw'

const run = (): BtwAnswer => ({ seq: 1, question: 'q', text: '', status: 'run', bare: false })
const line = (v: unknown) => JSON.stringify(v)
const delta = (text: string) => line({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } })

describe('btwQuestion', () => {
  it('вопрос после /btw; не /btw — null', () => {
    expect(btwQuestion('/btw  что это? ')).toBe('что это?')
    expect(btwQuestion('/btw')).toBe('')
    expect(btwQuestion('/btw\nвторая строка')).toBe('вторая строка')
    expect(btwQuestion('/btwx')).toBeNull()
    expect(btwQuestion('спроси /btw')).toBeNull()
  })
})

describe('reduceBtw', () => {
  it('текст копится по частям, result завершает', () => {
    let a = reduceBtw(run(), delta('При'))
    a = reduceBtw(a, delta('вет'))
    expect(a.text).toBe('Привет')
    a = reduceBtw(a, line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Привет!' }] } }))
    expect(a.text).toBe('Привет!')
    a = reduceBtw(a, line({ type: 'result', subtype: 'success', is_error: false, result: 'Привет!' }))
    expect(a).toMatchObject({ status: 'done', text: 'Привет!' })
    // После готового ответа строки не меняют его.
    expect(reduceBtw(a, delta('ещё'))).toBe(a)
  })

  it('ошибка result — статус error с текстом; мусорная строка — без изменений', () => {
    const a = run()
    expect(reduceBtw(a, 'not json')).toBe(a)
    expect(reduceBtw(a, line({ type: 'result', is_error: true, errors: ['лимит'] }))).toMatchObject({ status: 'error', error: 'лимит' })
  })
})
