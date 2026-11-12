import { act, fireEvent, render } from '@testing-library/react'
import { createRef } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))

const { InputBar, ASK_HINT, CLAUDE_HINT, CLAUDE_PLACEHOLDER, CONTINUATION_NOTE, PLACEHOLDER } = await import('./InputBar')
const { resetHistory, pushHistory } = await import('./history')
type Handle = import('./InputBar').InputBarHandle

function setup(over: Partial<Parameters<typeof InputBar>[0]> = {}) {
  const p = {
    disabled: false,
    completions: false,
    cwd: () => '/w',
    home: '/h',
    onRun: vi.fn(() => true),
    onAsk: vi.fn(),
    onEnterClaude: vi.fn(() => true),
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

  it('↵ при неготовой оболочке (onRun → false) оставляет текст и не пишет в историю', () => {
    const { p, ta, set, key } = setup()
    vi.mocked(p.onRun).mockReturnValue(false)
    set('make')
    key('Enter')
    expect(p.onRun).toHaveBeenCalledWith('make')
    expect(ta.value).toBe('make')
    key('ArrowUp')
    expect(ta.value).toBe('make')
  })

  it('подсказка о незаконченной команде', () => {
    const { container, rerender, p } = setup()
    expect(container.querySelector('.in-note')).toBeNull()
    rerender(<InputBar {...p} continuation />)
    expect(container.querySelector('.in-note')!.textContent).toBe(CONTINUATION_NOTE)
  })

  it('⌃C очищает строку; если прерван Claude — строку не трогает; ⌃L — onClearFeed', () => {
    const { p, ta, set, key } = setup()
    set('abc')
    key('c', { ctrlKey: true })
    expect(p.onInterrupt).toHaveBeenCalledWith(false, false)
    expect(ta.value).toBe('')
    vi.mocked(p.onInterrupt).mockReturnValue(true)
    set('abc')
    key('c', { ctrlKey: true })
    expect(ta.value).toBe('abc')
    set('')
    key('c', { ctrlKey: true })
    expect(p.onInterrupt).toHaveBeenLastCalledWith(true, false)
    key('l', { ctrlKey: true })
    expect(p.onClearFeed).toHaveBeenCalled()
  })

  it('неактивна, пока идёт команда', () => {
    const { ta } = setup({ disabled: true })
    expect(ta).toBeDisabled()
  })

  describe('команда claude и режим Claude', () => {
    const inMode = (c: HTMLElement) => c.querySelector('.input .in-mode') !== null

    it('`claude` ↵ — режим Claude: в PTY ничего, команда в истории, вид режима', () => {
      const { p, ta, set, key, container } = setup()
      set('claude')
      key('Enter')
      expect(p.onEnterClaude).toHaveBeenCalledWith(undefined)
      expect(p.onRun).not.toHaveBeenCalled()
      expect(ta.value).toBe('')
      expect(inMode(container)).toBe(true)
      expect(container.querySelector('.input .in-mode')!.textContent).toBe('◆')
      expect(container.querySelector('.input .ph')!.textContent).toBe(CLAUDE_PLACEHOLDER)
      expect(CLAUDE_PLACEHOLDER).toBe('Вопрос Claude…')
      expect(container.querySelector('.input .in-hint')!.textContent).toBe(CLAUDE_HINT)
      expect(CLAUDE_HINT).toBe('↵ отправить агенту · /exit выйти')
      key('ArrowUp')
      expect(ta.value).toBe('claude')
    })

    it('`claude "вопрос"` — вопрос без кавычек и режим Claude', () => {
      const { p, set, key, container } = setup()
      set('claude "что тут?"')
      key('Enter')
      expect(p.onEnterClaude).toHaveBeenCalledWith('что тут?')
      expect(p.onRun).not.toHaveBeenCalled()
      expect(inMode(container)).toBe(true)
    })

    it('`claude --tui -c` пишет `claude -c` в оболочку, `claude mcp list` — как есть', () => {
      const { p, set, key, container } = setup()
      set('claude --tui -c')
      key('Enter')
      expect(p.onRun).toHaveBeenLastCalledWith('claude -c')
      set('claude mcp list')
      key('Enter')
      expect(p.onRun).toHaveBeenLastCalledWith('claude mcp list')
      expect(p.onEnterClaude).not.toHaveBeenCalled()
      expect(inMode(container)).toBe(false)
    })

    it('в режиме ↵ и ⌘↵ — вопрос Claude, не в оболочку', () => {
      const { p, ta, set, key } = setup()
      set('claude')
      key('Enter')
      set('ls')
      key('Enter')
      expect(p.onAsk).toHaveBeenLastCalledWith('ls')
      expect(ta.value).toBe('')
      set('ещё')
      key('Enter', { metaKey: true })
      expect(p.onAsk).toHaveBeenLastCalledWith('ещё')
      // Внутри режима `claude` — тоже вопрос, а не повторный вход.
      set('claude')
      key('Enter')
      expect(p.onAsk).toHaveBeenLastCalledWith('claude')
      expect(p.onRun).not.toHaveBeenCalled()
    })

    it('/exit, exit и esc на пустой строке выходят из режима', () => {
      const { p, set, key, container } = setup()
      for (const cmd of ['/exit', 'exit']) {
        set('claude')
        key('Enter')
        set(cmd)
        key('Enter')
        expect(inMode(container)).toBe(false)
        expect(container.querySelector('.input .ph')!.textContent).toBe(PLACEHOLDER)
        expect(container.querySelector('.input .in-hint')!.textContent).toBe(ASK_HINT)
      }
      expect(p.onAsk).not.toHaveBeenCalled()
      set('claude')
      key('Enter')
      set('x')
      key('Escape')
      expect(inMode(container)).toBe(true)
      set('')
      key('Escape')
      expect(inMode(container)).toBe(false)
      // После выхода ↵ снова идёт в оболочку.
      set('ls')
      key('Enter')
      expect(p.onRun).toHaveBeenLastCalledWith('ls')
    })

    it('⌘↵ с /exit в режиме тоже выходит; вне режима — вопрос', () => {
      const { p, set, key, container } = setup()
      set('/exit')
      key('Enter', { metaKey: true })
      expect(p.onAsk).toHaveBeenLastCalledWith('/exit')
      set('claude')
      key('Enter')
      set('/exit')
      key('Enter', { metaKey: true })
      expect(inMode(container)).toBe(false)
      expect(p.onAsk).toHaveBeenCalledTimes(1)
    })

    it('во время продолжения команды (PS2) `claude` уходит в оболочку', () => {
      const { p, set, key, container } = setup({ continuation: true })
      set('claude')
      key('Enter')
      expect(p.onRun).toHaveBeenCalledWith('claude')
      expect(p.onEnterClaude).not.toHaveBeenCalled()
      expect(inMode(container)).toBe(false)
    })

    it('не удалось запустить сессию (onEnterClaude → false) — режим не включается', () => {
      const { p, ta, set, key, container } = setup({ onEnterClaude: vi.fn(() => false) })
      set('claude')
      key('Enter')
      expect(p.onEnterClaude).toHaveBeenCalled()
      expect(inMode(container)).toBe(false)
      expect(ta.value).toBe('')
    })

    it('⌃C в режиме: onInterrupt с признаком режима, в оболочку не уходит', () => {
      const { p, ta, set, key } = setup()
      set('claude')
      key('Enter')
      set('abc')
      key('c', { ctrlKey: true })
      expect(p.onInterrupt).toHaveBeenLastCalledWith(false, true)
      expect(ta.value).toBe('')
    })

    it('подсказки путей в режиме выключены', async () => {
      const { set, key } = setup({ completions: true })
      set('claude')
      key('Enter')
      invoke.mockClear()
      set('cat s')
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50))
      })
      expect(invoke).not.toHaveBeenCalledWith('fs_list', expect.anything())
    })
  })

  describe('выборка claude … и /…', () => {
    const opts = (c: HTMLElement) => [...c.querySelectorAll('.hp-row .hp-n')].map((e) => e.textContent)

    it('`claude` — сразу весь список; ↵ без выбора входит в режим', () => {
      const { container, set, key, p } = setup({ hints: true })
      set('claude')
      expect(opts(container)[0]).toBe('claude')
      expect(opts(container)).toContain('--tui')
      key('Enter')
      expect(p.onEnterClaude).toHaveBeenCalledWith(undefined)
      expect(container.querySelector('.hp')).toBeNull()
    })

    it('↓↓ ↵ — `claude --tui` в оболочку (как claude)', () => {
      const { set, key, p } = setup({ hints: true })
      set('claude')
      key('ArrowDown')
      key('ArrowDown')
      key('Enter')
      expect(p.onRun).toHaveBeenCalledWith('claude')
      expect(p.onEnterClaude).not.toHaveBeenCalled()
    })

    it('Tab подставляет аргумент; вопрос без совпадений — без попапа', () => {
      const { container, ta, set, key } = setup({ hints: true })
      set('claude doc')
      expect(opts(container)).toEqual(['doctor'])
      key('Tab')
      expect(ta.value).toBe('claude doctor ')
      expect(container.querySelector('.hp')).toBeNull()
      set('claude привет')
      expect(container.querySelector('.hp')).toBeNull()
    })

    it('выключена без hints и при незаконченной команде', () => {
      const a = setup()
      a.set('claude')
      expect(a.container.querySelector('.hp')).toBeNull()
      a.unmount()
      const b = setup({ hints: true, continuation: true })
      b.set('claude')
      expect(b.container.querySelector('.hp')).toBeNull()
    })

    it('режим Claude: `/` — slash-команды из Rust; выбор ↵ отправляет', async () => {
      invoke.mockImplementation((cmd: string) =>
        Promise.resolve(cmd === 'claude_slash_commands' ? [{ name: 'ship', description: 'Выпуск', source: 'user' }] : []),
      )
      const { container, set, key, p } = setup({ hints: true })
      set('claude')
      key('Enter')
      set('/')
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0))
      })
      expect(invoke).toHaveBeenCalledWith('claude_slash_commands', { cwd: '/w' })
      expect([...container.querySelectorAll('.hp-h')].map((h) => h.textContent)).toEqual(['Встроенные', 'Личные'])
      expect(opts(container).at(-1)).toBe('/ship')
      set('/mod')
      key('ArrowDown')
      key('Enter')
      expect(p.onAsk).toHaveBeenCalledWith('/model')
    })

    it('режим Claude: `/exi` ↓ ↵ — выход из режима', () => {
      const { container, set, key, p } = setup({ hints: true })
      set('claude')
      key('Enter')
      set('/exi')
      key('ArrowDown')
      key('Enter')
      expect(p.onAsk).not.toHaveBeenCalled()
      expect(container.querySelector('.in-mode')).toBeNull()
    })

    it('вне режима `/` попап не открывает', () => {
      const { container, set } = setup({ hints: true })
      set('/')
      expect(container.querySelector('.hp')).toBeNull()
    })
  })
})

describe('InputBar: /model', () => {
  beforeEach(() => {
    invoke.mockReset()
    invoke.mockResolvedValue([])
    resetHistory()
  })

  const enterMode = (s: ReturnType<typeof setup>) => {
    s.set('claude')
    s.key('Enter')
  }

  it('в режиме Claude `/model` ↵ открывает выбор, а не отправляет вопрос', () => {
    const s = setup({ onChooseModel: vi.fn(), modelInfo: () => ({ current: 'fable', effort: 'medium' }) })
    enterMode(s)
    s.set('/model')
    s.key('Enter')
    expect(s.p.onAsk).not.toHaveBeenCalled()
    expect(s.container.querySelector('.mp')).not.toBeNull()
    expect(s.ta.value).toBe('')
    // Открыт на текущей модели.
    expect(s.container.querySelector('.mp [aria-selected="true"] .hp-n')!.textContent).toBe('Fable 5.2')
  })

  it('↓ и s — только сессия; ←/→ усилие; выбор закрывает карточку', () => {
    const onChooseModel = vi.fn()
    const s = setup({ onChooseModel, modelInfo: () => ({ current: 'default', effort: 'medium' }) })
    enterMode(s)
    s.set('/model')
    s.key('Enter')
    s.key('ArrowDown')
    s.key('ArrowRight')
    s.key('s')
    expect(onChooseModel).toHaveBeenCalledWith({ alias: 'opus', effort: 'high', persist: false })
    expect(s.container.querySelector('.mp')).toBeNull()
    expect(s.ta.value).toBe('')
  })

  it('цифра и ↵ — по умолчанию; esc — отмена, режим Claude остаётся', () => {
    const onChooseModel = vi.fn()
    const s = setup({ onChooseModel, modelInfo: () => ({ current: null, effort: null }) })
    enterMode(s)
    s.set('/model')
    s.key('Enter')
    s.key('3')
    s.key('Enter')
    expect(onChooseModel).toHaveBeenCalledWith({ alias: 'fable', effort: null, persist: true })
    s.set('/model')
    s.key('Enter')
    s.key('Escape')
    expect(s.container.querySelector('.mp')).toBeNull()
    expect(onChooseModel).toHaveBeenCalledTimes(1)
    expect(s.container.querySelector('.in-mode')).not.toBeNull()
  })

  it('⌘↵ `/model` вне режима Claude тоже открывает выбор', () => {
    const s = setup({ onChooseModel: vi.fn(), modelInfo: () => ({ current: null, effort: null }) })
    s.set('/model')
    s.key('Enter', { metaKey: true })
    expect(s.p.onAsk).not.toHaveBeenCalled()
    expect(s.container.querySelector('.mp')).not.toBeNull()
  })

  it('без onChooseModel `/model` уходит вопросом, как раньше', () => {
    const s = setup()
    enterMode(s)
    s.set('/model')
    s.key('Enter')
    expect(s.p.onAsk).toHaveBeenCalledWith('/model')
  })
})

describe('InputBar: свой ответ на вопрос агента', () => {
  beforeEach(() => {
    invoke.mockReset()
    invoke.mockResolvedValue([])
    resetHistory()
  })

  it('плейсхолдер и подсказка; ↵ отдаёт текст в answer, а не в оболочку; esc — назад к вопросу', async () => {
    const { ANSWER_PLACEHOLDER, ANSWER_HINT } = await import('./InputBar')
    const answer = { onSubmit: vi.fn(), onCancel: vi.fn() }
    const s = setup({ answer })
    expect(s.container.querySelector('.ph')!.textContent).toBe(ANSWER_PLACEHOLDER)
    expect(ANSWER_PLACEHOLDER).toBe('Ваш ответ на вопрос…')
    expect(s.container.querySelector('.in-hint')!.textContent).toBe(ANSWER_HINT)
    s.set('  синий ')
    s.key('Enter')
    expect(answer.onSubmit).toHaveBeenCalledWith('синий')
    expect(s.p.onRun).not.toHaveBeenCalled()
    expect(s.ta.value).toBe('')
    s.key('Escape')
    expect(answer.onCancel).toHaveBeenCalled()
  })
})

describe('InputBar: очередь сообщений Claude', () => {
  beforeEach(() => {
    invoke.mockReset()
    invoke.mockResolvedValue([])
    resetHistory()
  })

  it('↑ в пустой строке забирает последнее из очереди (раньше истории); не пусто — история', () => {
    pushHistory('ls')
    const recall = vi.fn<() => string | null>().mockReturnValueOnce('второе').mockReturnValue(null)
    const { ta, key } = setup({ queue: { recall, sendNext: vi.fn(() => false), dismissHint: vi.fn(() => false) } })
    key('ArrowUp')
    expect(ta.value).toBe('второе')
    expect(recall).toHaveBeenCalledTimes(1)
    // Строка не пуста — ↑ листает историю, очередь не трогается.
    key('ArrowUp')
    expect(ta.value).toBe('ls')
    expect(recall).toHaveBeenCalledTimes(1)
  })

  it('↵ на пустой строке — следующее из очереди; esc — сначала убирает подсказку паузы', () => {
    const sendNext = vi.fn(() => true)
    const dismissHint = vi.fn().mockReturnValueOnce(true).mockReturnValue(false)
    const { p, key, set, container } = setup({ queue: { recall: vi.fn(() => null), sendNext, dismissHint } })
    key('Enter')
    expect(sendNext).toHaveBeenCalledTimes(1)
    expect(p.onRun).not.toHaveBeenCalled()
    set('claude')
    key('Enter')
    expect(container.querySelector('.in-mode')).not.toBeNull()
    key('Escape')
    // Первый esc — подсказка паузы, режим Claude остаётся.
    expect(container.querySelector('.in-mode')).not.toBeNull()
    key('Escape')
    expect(container.querySelector('.in-mode')).toBeNull()
  })
})
