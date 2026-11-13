import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn(() => Promise.resolve()) }))

const { Markdown } = await import('./Markdown')

describe('Markdown: курсор стриминга', () => {
  // Ответ на полуслове может кончаться пустым элементом: курсор внутри него ронял карточку (React #137).
  it.each([
    ['черта', 'текст\n\n---'],
    ['перенос строки', 'строка  \n'],
    ['галочка задачи', '- [ ] '],
    ['картинка', '![](https://example.com/a.png)'],
  ])('ответ кончается пустым элементом (%s) — карточка рисуется, курсор после него', (_, text) => {
    const { container } = render(<Markdown text={text} streaming />)
    expect(container.querySelector('.caret')).not.toBeNull()
    expect(container.querySelector('hr .caret, br .caret, input .caret, img .caret')).toBeNull()
  })

  it('обычный текст — курсор в конце абзаца', () => {
    const { container } = render(<Markdown text="привет" streaming />)
    expect(container.querySelector('p > .caret')).not.toBeNull()
  })
})
