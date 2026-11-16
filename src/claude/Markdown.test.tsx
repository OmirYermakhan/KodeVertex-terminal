import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn(() => Promise.resolve()) }))

const { Markdown, splitBlocks } = await import('./Markdown')

describe('splitBlocks: блоки печатающегося ответа', () => {
  it('граница — пустая строка перед новым блоком; склейка блоков даёт исходный текст', () => {
    const text = '# Заголовок\n\nабзац\nещё\n\n> цитата\n\n'
    const b = splitBlocks(text)
    expect(b).toEqual(['# Заголовок\n', 'абзац\nещё\n', '> цитата\n\n'])
    expect(b.join('\n')).toBe(text)
  })

  it('не рвёт: код в ```, свободный список, продолжение с отступом, абзац перед ```diff, определения ссылок', () => {
    expect(splitBlocks('```\na\n\nb\n```\n\nпосле')).toEqual(['```\na\n\nb\n```\n', 'после'])
    expect(splitBlocks('- a\n\n- b\n\n  ещё b\n\n1. c')).toHaveLength(1)
    expect(splitBlocks('`f.kt`\n\n```diff\n+x\n```')).toHaveLength(1)
    expect(splitBlocks('см. [x]\n\n[x]: https://a.b')).toHaveLength(1)
  })

  it('стриминг рисует то же, что готовый ответ', () => {
    const text = '# Т\n\nабзац **жирный**\n\n- a\n- b\n\n```ts\nconst a = 1\n```\n\nконец'
    const live = render(<Markdown text={text} streaming diagrams={false} />).container
    live.querySelectorAll('.caret').forEach((c) => c.remove())
    const done = render(<Markdown text={text} diagrams={false} />).container
    // Отличаются только переводы строк между блоками (пробельный текст между элементами).
    const flat = (h: string) => h.replace(/>\n+</g, '><')
    expect(flat(live.innerHTML)).toBe(flat(done.innerHTML))
  })

  it('курсор — один, в последнем блоке', () => {
    const { container } = render(<Markdown text={'первый\n\nвторой'} streaming />)
    expect(container.querySelectorAll('.caret')).toHaveLength(1)
    expect(container.querySelector('.md > p:last-of-type > .caret')).not.toBeNull()
  })
})

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

describe('Markdown: ссылки', () => {
  it('подсказка — хост ссылки; системного меню у ссылки нет', () => {
    const { container } = render(<Markdown text={'[документация](https://docs.example.com/a?b=1) и <mailto:me@x.org>'} />)
    const [a, m] = [...container.querySelectorAll('a')]
    expect(a.title).toBe('docs.example.com')
    expect(m.title).toBe('me@x.org')
    const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    a.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(true)
  })

  it('текст выдаёт себя за другой адрес — вопрос в панели вместо открытия; обычная ссылка — сразу в браузер', async () => {
    const { openUrl } = await import('@tauri-apps/plugin-opener')
    const { useLinkAsk } = await import('../feed/linkAsk')
    vi.mocked(openUrl).mockClear()
    const pane = document.createElement('div')
    pane.dataset.paneId = 'pp'
    document.body.append(pane)
    const { container } = render(<Markdown text={'[github.com/acme](https://evil.example/x) [docs.github.com](https://docs.github.com/y) [тут](https://evil.example/z)'} />, { container: pane })
    const [fake, sub, plain] = [...container.querySelectorAll('a')]
    fireEvent.click(fake)
    expect(openUrl).not.toHaveBeenCalled()
    expect(useLinkAsk.getState().asks.pp).toEqual({ url: 'https://evil.example/x', host: 'evil.example', text: 'github.com/acme' })
    fireEvent.click(sub)
    fireEvent.click(plain)
    expect(vi.mocked(openUrl).mock.calls).toEqual([['https://docs.github.com/y'], ['https://evil.example/z']])
    pane.remove()
  })
})
