import { act, fireEvent, render } from '@testing-library/react'
import { createRef } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))

const { InputBar, ASK_HINT, PLACEHOLDER } = await import('./InputBar')
const { resetHistory, pushHistory } = await import('./history')
type Handle = import('./InputBar').InputBarHandle

function setup(over: Partial<Parameters<typeof InputBar>[0]> = {}) {
  const p = {
    disabled: false,
    completions: false,
    cwd: () => '/w',
    home: '/h',
    onRun: vi.fn(),
    onAsk: vi.fn(),
    onInterrupt: vi.fn(() => false),
    onClearFeed: vi.fn(),
    ...over,
  }
  const ref = createRef<Handle>()
  const r = render(<InputBar ref={ref} {...p} />)
  const ta = r.container.querySelector('textarea')!
  const set = (v: string, cursor = v.length) =>
    fireEvent.change(ta, { target: { value: v, selectionStart: cursor, selectionEnd: cursor } })
  const key = (k: string, o: KeyboardEventInit = {}) => fireEvent.keyDown(ta, { key: k, ...o })
  return { ...r, p, ta, set, key, ref }
}

describe('InputBar', () => {
  beforeEach(() => {
    invoke.mockReset()
    invoke.mockResolvedValue([])
    resetHistory()
  })

  it('вид по макету: плейсхолдер, подсказка справа, без плашек папки/ветки', () => {
    const { container, ref } = setup()
    expect(container.querySelector('.input .ph')!.textContent).toBe(PLACEHOLDER)
    expect(PLACEHOLDER).toBe('Команда или вопрос Claude…')
    expect(container.querySelector('.input .in-hint')!.textContent).toBe(ASK_HINT)
    expect(ASK_HINT).toBe('⌘↵ отправить агенту')
    expect(container.querySelector('.ctx')).toBeNull()
    // Мигающий курсор — только в фокусе.
    expect(container.querySelector('.caret')).toBeNull()
    act(() => ref.current!.focus())
    expect(container.querySelector('.ph .caret')).not.toBeNull()
  })

  it('↵ — onRun и очистка; ⌘↵ — onAsk', () => {
    const { p, ta, set, key } = setup()
    set('ls')
    key('Enter')
    expect(p.onRun).toHaveBeenCalledWith('ls')
    expect(ta.value).toBe('')
    set('почему?')
    key('Enter', { metaKey: true })
    expect(p.onAsk).toHaveBeenCalledWith('почему?')
    expect(ta.value).toBe('')
  })

  it('⇧↵ — новая строка, поле растёт до 8 строк', () => {
    const { p, ta, set, key } = setup()
    set('a')
    key('Enter', { shiftKey: true })
    expect(p.onRun).not.toHaveBeenCalled()
    set('a\nb')
    expect(ta.rows).toBe(2)
    set(Array(12).fill('x').join('\n'))
    expect(ta.rows).toBe(8)
  })

  it('↑/↓ листают историю только с первой/последней строки', () => {
    pushHistory('first')
    pushHistory('second')
    const { ta, set, key } = setup()
    key('ArrowUp')
    expect(ta.value).toBe('second')
    key('ArrowUp')
    expect(ta.value).toBe('first')
    key('ArrowDown')
    expect(ta.value).toBe('second')
    key('ArrowDown')
    expect(ta.value).toBe('')
    // Курсор на второй строке — ↑ двигает курсор, а не историю.
    set('l1\nl2')
    key('ArrowUp')
    expect(ta.value).toBe('l1\nl2')
    set('l1\nl2', 1)
    key('ArrowDown')
    expect(ta.value).toBe('l1\nl2')
  })

  it('⌃C очищает строку; если прерван Claude — строку не трогает; ⌃L — onClearFeed', () => {
    const { p, ta, set, key } = setup()
    set('abc')
    key('c', { ctrlKey: true })
    expect(p.onInterrupt).toHaveBeenCalled()
    expect(ta.value).toBe('')
    vi.mocked(p.onInterrupt).mockReturnValue(true)
    set('abc')
    key('c', { ctrlKey: true })
    expect(ta.value).toBe('abc')
    key('l', { ctrlKey: true })
    expect(p.onClearFeed).toHaveBeenCalled()
  })

  it('неактивна, пока идёт команда', () => {
    const { ta } = setup({ disabled: true })
    expect(ta).toBeDisabled()
  })
})
