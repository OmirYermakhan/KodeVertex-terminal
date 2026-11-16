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

describe('Markdown: diff как в Android Studio', () => {
  it('```diff — строки с видом и подсветкой языка файла из текста перед блоком', () => {
    const { container } = render(<Markdown text={'`core/RemoteConfig.kt`\n\n```diff\n@@ -1 +1 @@\n-val a = 1\n+fun b(): Int = 2\n```'} diagrams={false} />)
    expect(container.querySelector('pre.md-diff')).toBeTruthy()
    expect(container.querySelectorAll('.md-dl.a')).toHaveLength(1)
    expect(container.querySelector('.md-dl.a .hljs-keyword')?.textContent).toBe('fun')
    expect(container.querySelector('.md-dl.d .hljs-number')?.textContent).toBe('1')
  })
})
