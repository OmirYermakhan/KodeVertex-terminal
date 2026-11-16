import { describe, expect, it } from 'vitest'
import { quoteAttachment } from '../attach/fromFeed'
import { serialize } from '../attach/serialize'
import { TOKEN_CHAR } from '../attach/types'
import { quoteSelection } from './QuoteReply'

function feed() {
  const f = document.createElement('div')
  f.innerHTML =
    '<div class="card" data-item-id="c1"><div class="who">ГЛАВНЫЙ</div><div class="ans-body"><p id="a">Попутный рефакторинг: логика перенесена.</p><p id="b">Второй абзац.</p></div></div>' +
    '<div class="card" data-item-id="c2"><div class="ans-body"><p id="c">Другой ответ</p></div></div>'
  document.body.append(f)
  return f
}

function select(f: HTMLElement, from: string, to: string, end?: number) {
  const s = window.getSelection()!
  s.removeAllRanges()
  const r = document.createRange()
  r.setStart(f.querySelector(from)!.firstChild!, 0)
  const t = f.querySelector(to)!.firstChild!
  r.setEnd(t, end ?? t.textContent!.length)
  s.addRange(r)
  return s
}

describe('«Ответить» на выделенный фрагмент', () => {
  it('выделение в тексте одного ответа — его id и текст', () => {
    const f = feed()
    expect(quoteSelection(f, select(f, '#a', '#a', 20))).toMatchObject({ id: 'c1', text: 'Попутный рефакторинг' })
    expect(quoteSelection(f, select(f, '#a', '#b'))?.text).toContain('Второй абзац.')
    f.remove()
  })

  it('через две карточки, в заголовке или пустое — нет', () => {
    const f = feed()
    expect(quoteSelection(f, select(f, '#a', '#c'))).toBeNull()
    expect(quoteSelection(f, select(f, '.who', '.who'))).toBeNull()
    window.getSelection()!.removeAllRanges()
    expect(quoteSelection(f)).toBeNull()
    f.remove()
  })

  it('цитата уходит Claude фрагментом сообщения, подпись значка — «Цитата»', () => {
    const t = quoteAttachment('Попутный рефакторинг: логика перенесена в RemoteConfig', { name: 'Главный' } as never, 'c1')
    expect(t.label.startsWith('Цитата: «')).toBe(true)
    const s = serialize({ text: `${TOKEN_CHAR} почему так?`, tokens: [t] }, '/w')
    expect(s.text).toContain('<quoted_message n="1" author="Главный" part="excerpt">\nПопутный рефакторинг: логика перенесена в RemoteConfig\n</quoted_message>')
  })
})

describe('правый щелчок по выделению в ответе', () => {
  it('своё меню вместо системного; вне ответа — системное', async () => {
    const { vi } = await import('vitest')
    const popup = vi.fn(() => Promise.resolve())
    const items: unknown[][] = []
    vi.doMock('@tauri-apps/api/menu', () => ({ Menu: { new: (o: { items: unknown[] }) => (items.push(o.items), Promise.resolve({ popup, close: () => Promise.resolve() })) } }))
    vi.resetModules()
    const { render } = await import('@testing-library/react')
    const { QuoteReply } = await import('./QuoteReply')
    const f = feed()
    render(<QuoteReply feedRef={{ current: f }} onQuote={() => {}} />)
    select(f, '#a', '#a')
    const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    f.querySelector('#a')!.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(true)
    await new Promise((r) => setTimeout(r, 0))
    expect(popup).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(items[0])).toContain('Ответить')
    window.getSelection()!.removeAllRanges()
    const e2 = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    f.querySelector('#a')!.dispatchEvent(e2)
    expect(e2.defaultPrevented).toBe(false)
    // У ссылки системного меню нет («Открыть ссылку» открыла бы её в окне приложения), даже без выделения.
    const a = document.createElement('a')
    a.href = 'https://example.com'
    a.textContent = 'ссылка'
    f.querySelector('#b')!.append(a)
    const e3 = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    a.dispatchEvent(e3)
    expect(e3.defaultPrevented).toBe(true)
    expect(popup).toHaveBeenCalledTimes(1)
    f.remove()
  })
})
