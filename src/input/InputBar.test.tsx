import { act, fireEvent, render } from '@testing-library/react'
import { createRef } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))
const dialogOpen = vi.fn(() => Promise.resolve(null))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: () => dialogOpen() }))

const { InputBar, ASK_HINT, CLAUDE_HINT, CLAUDE_PLACEHOLDER, CONTINUATION_NOTE, PLACEHOLDER, UNSUPPORTED_NOTE } = await import('./InputBar')
const { AT_HINT } = await import('../completion/CompletionPopup')
const { TOKEN_CHAR: T } = await import('../attach/types')
const { resetHistory, pushHistory } = await import('./history')
const { domText, setSelection, getSelection: getSel } = await import('./richDom')
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
  const ed = r.container.querySelector<HTMLElement>('.in-ta')!
  const ta = {
    get value() {
      return domText(ed)
    },
  }
  // Набор: текст в поле, курсор — в cursor, событие input (как после набора браузером).
  const set = (v: string, cursor = v.length) => {
    if (document.activeElement !== ed) act(() => ed.focus())
    ed.textContent = v
    setSelection(ed, cursor)
    fireEvent.input(ed)
  }
  const key = (k: string, o: KeyboardEventInit = {}) => fireEvent.keyDown(ed, { key: k, ...o })
  return { ...r, p, ta, ed, set, key, ref }
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

  it('⇧↵ — новая строка в месте курсора', () => {
    const { p, ta, set, key } = setup()
    set('ab', 1)
    key('Enter', { shiftKey: true })
    expect(p.onRun).not.toHaveBeenCalled()
    expect(ta.value).toBe('a\nb')
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
    const { ed } = setup({ disabled: true })
    expect(ed).toHaveAttribute('aria-disabled', 'true')
    expect(ed).not.toHaveAttribute('contenteditable', 'plaintext-only')
  })

  it('выключенная строка: фокус не берёт, клавиши ничего не делают (⌫, ⇧↵, ↑, ⌃D, ⌘O, ↵)', async () => {
    pushHistory('ls')
    const recall = vi.fn(() => 'из очереди')
    const onEof = vi.fn()
    const s = setup({ onEof, queue: { recall, sendNext: vi.fn(() => true), dismissHint: vi.fn(() => false) } })
    s.set('abc')
    s.rerender(<InputBar ref={s.ref} {...s.p} onEof={onEof} disabled />)
    // Фокус, бывший в поле, уходит; программный фокус и клик его не возвращают.
    expect(document.activeElement).not.toBe(s.ed)
    act(() => s.ref.current!.focus())
    expect(document.activeElement).not.toBe(s.ed)
    act(() => s.ed.focus())
    expect(document.activeElement).not.toBe(s.ed)
    for (const [k, o] of [['Backspace', {}], ['Delete', {}], ['Enter', { shiftKey: true }], ['ArrowUp', {}], ['Enter', {}], ['Enter', { metaKey: true }]] as const) {
      s.key(k, o)
    }
    expect(s.ta.value).toBe('abc')
    expect(recall).not.toHaveBeenCalled()
    expect(s.p.onRun).not.toHaveBeenCalled()
    expect(s.p.onAsk).not.toHaveBeenCalled()
    s.rerender(<InputBar ref={s.ref} {...s.p} onEof={onEof} disabled />)
    s.ed.textContent = ''
    s.key('d', { ctrlKey: true })
    expect(onEof).not.toHaveBeenCalled()
    s.key('o', { metaKey: true, code: 'KeyO' } as KeyboardEventInit)
    expect(invoke).not.toHaveBeenCalledWith('plugin:dialog|open', expect.anything())
    expect(dialogOpen).not.toHaveBeenCalled()
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

describe('InputBar: значки вложений', () => {
  beforeEach(() => {
    invoke.mockReset()
    invoke.mockResolvedValue([])
    resetHistory()
  })
  const tok = (id: string, over: Record<string, unknown> = {}) => ({ id, kind: 'file' as const, label: `${id}.tsx`, path: `/w/${id}.tsx`, ...over })
  const claude = (s: ReturnType<typeof setup>) => {
    s.set('claude')
    s.key('Enter')
  }
  const caretAt = (s: ReturnType<typeof setup>, pos: number) => setSelection(s.ed, pos)

  it('вставка у курсора только в режиме Claude; значок — span .tk; счёт значков наружу', () => {
    const onTokens = vi.fn()
    const s = setup({ onTokens })
    expect(s.ref.current!.insertTokens([tok('a')])).toBe(false)
    claude(s)
    s.set('см ')
    act(() => void s.ref.current!.insertTokens([tok('a'), tok('b')]))
    expect(s.ta.value).toBe(`см ${T} ${T}`)
    expect([...s.ed.querySelectorAll('.tk')].map((e) => e.textContent)).toEqual(['a.tsx', 'b.tsx'])
    expect(onTokens).toHaveBeenLastCalledWith(2)
  })

  it('⌘L из оболочки: claude: true переключает строку в режим Claude', () => {
    const s = setup()
    s.set('почини ')
    act(() => void s.ref.current!.insertTokens([tok('npm', { kind: 'block', label: 'npm test', block: { command: 'npm test', exitCode: 1, cwd: '/w', output: '', durationMs: 1, at: 0 } })], { claude: true }))
    expect(s.container.querySelector('.in-mode')).not.toBeNull()
    expect(s.ed.querySelector('.tk')!.className).toBe('tk blkt fail')
    expect(s.ed.querySelector('.tk .mut')!.textContent).toBe('· 1')
  })

  it('⌫ рядом со значком: первое — выделяет (.tk.sel), второе — удаляет; ←/→ перескакивают его', () => {
    const s = setup()
    claude(s)
    s.set('ab')
    act(() => void s.ref.current!.insertTokens([tok('x')]))
    expect(s.ta.value).toBe(`ab ${T}`)
    s.key('Backspace')
    expect(s.ed.querySelector('.tk')!.classList.contains('sel')).toBe(true)
    expect(s.ta.value).toBe(`ab ${T}`)
    s.key('Backspace')
    expect(s.ta.value).toBe('ab ')
    // ←/→ — как одна буква.
    act(() => void s.ref.current!.insertTokens([tok('y')]))
    expect(s.ta.value).toBe(`ab ${T}`)
    caretAt(s, 3)
    s.key('ArrowRight')
    expect(getSel(s.ed)).toEqual({ start: 4, end: 4 })
    s.key('ArrowLeft')
    expect(getSel(s.ed)).toEqual({ start: 3, end: 3 })
    // ⌦ симметрично.
    s.key('Delete')
    expect(s.ed.querySelector('.tk.sel')).not.toBeNull()
    s.key('Delete')
    expect(s.ta.value).toBe('ab ')
  })

  it('↵ отдаёт текст со значками и сами значки; другая клавиша снимает выделение значка', () => {
    const s = setup()
    claude(s)
    s.set('см')
    act(() => void s.ref.current!.insertTokens([tok('f')]))
    s.key('Backspace')
    s.key('a')
    expect(s.ed.querySelector('.tk.sel')).toBeNull()
    s.key('Enter')
    expect(s.p.onAsk).toHaveBeenCalledWith(`см ${T}`, [expect.objectContaining({ id: 'f', path: '/w/f.tsx' })])
    expect(s.ta.value).toBe('')
  })

  it('красный значок не уходит: подсказка, строка остаётся', () => {
    const s = setup()
    claude(s)
    s.set('глянь ')
    act(() => void s.ref.current!.insertTokens([tok('clip', { kind: 'unsupported', label: 'clip.mov', reason: 'Видео' })]))
    s.key('Enter')
    expect(s.p.onAsk).not.toHaveBeenCalled()
    expect(s.container.querySelector('.in-note')!.textContent).toBe(UNSUPPORTED_NOTE)
    expect(s.ta.value).toBe(`глянь ${T}`)
  })

  it('вставка текста вокруг значков: значки на месте; копирование — читаемым видом', () => {
    const s = setup()
    claude(s)
    s.set('a')
    act(() => void s.ref.current!.insertTokens([tok('f')]))
    caretAt(s, 1)
    fireEvent.paste(s.ed, { clipboardData: { getData: () => 'XY', types: ['text/plain'], items: [] } })
    expect(s.ta.value).toBe(`aXY ${T}`)
    setSelection(s.ed, 0, s.ta.value.length)
    const setData = vi.fn()
    fireEvent.copy(s.ed, { clipboardData: { setData } })
    expect(setData).toHaveBeenCalledWith('text/plain', 'aXY /w/f.tsx')
  })

  it('набор браузером рядом со значком сохраняет значок', () => {
    const s = setup()
    claude(s)
    act(() => void s.ref.current!.insertTokens([tok('f')]))
    const zw = [...s.ed.childNodes].filter((n) => n.nodeType === 3).at(-1) as Text
    zw.data = zw.data + '!'
    fireEvent.input(s.ed)
    expect(s.ta.value).toBe(`${T}!`)
    s.key('Enter')
    expect(s.p.onAsk).toHaveBeenCalledWith(`${T}!`, [expect.objectContaining({ id: 'f' })])
  })

  it('файлы: в оболочке — экранированные пути через пробел, в режиме Claude — значки (Rust определяет тип)', async () => {
    invoke.mockImplementation((cmd: string, a: { paths: string[] }) =>
      Promise.resolve(cmd === 'attach_inspect' ? a.paths.map((p) => ({ path: p, name: p.split('/').pop(), exists: true, isDir: p.endsWith('dir'), size: 10 })) : []),
    )
    const s = setup()
    s.set('ls')
    act(() => s.ref.current!.insertPaths(['/w/my file.txt', '/w/b.png']))
    expect(s.ta.value).toBe('ls /w/my\\ file.txt /w/b.png')
    s.set('')
    claude(s)
    await act(async () => {
      s.ref.current!.insertPaths(['/w/a.png', '/w/dir', '/w/c.mov'])
      await new Promise((r) => setTimeout(r, 0))
    })
    expect([...s.ed.querySelectorAll('.tk')].map((e) => [e.className, e.textContent])).toEqual([
      ['tk', 'a.png'],
      ['tk', 'dir/'],
      ['tk err', 'c.mov'],
    ])
  })

  it('↑ в пустой строке возвращает из очереди сообщение со значками', () => {
    const recall = vi.fn().mockReturnValueOnce({ text: `x ${T}`, tokens: [tok('q')] }).mockReturnValue(null)
    const s = setup({ queue: { recall, sendNext: vi.fn(() => false), dismissHint: vi.fn(() => false) } })
    claude(s)
    s.key('ArrowUp')
    expect(s.ta.value).toBe(`x ${T}`)
    expect(s.ed.querySelector('.tk')!.textContent).toBe('q.tsx')
  })

  it('`@путь` в режиме Claude: подсказки путей, ↵ вставляет значок вместо `@…`', async () => {
    invoke.mockImplementation((cmd: string, a: { paths?: string[] }) => {
      if (cmd === 'fs_list') return Promise.resolve([{ name: 'Form.tsx', isDir: false, isSymlink: false }, { name: 'styles', isDir: true, isSymlink: false }])
      if (cmd === 'attach_inspect') return Promise.resolve(a.paths!.map((p) => ({ path: p, name: p.split('/').pop(), exists: true, isDir: false, size: 1 })))
      return Promise.resolve(null)
    })
    const s = setup({ completions: true })
    claude(s)
    s.set('глянь @Fo')
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })
    expect(invoke).toHaveBeenCalledWith('fs_list', expect.objectContaining({ dir: '/w' }))
    expect(s.container.querySelector('.cp-hint')!.textContent).toBe(AT_HINT)
    s.key('Enter')
    expect(s.p.onAsk).not.toHaveBeenCalled()
    expect(s.ta.value).toBe(`глянь ${T}`)
    expect(s.ed.querySelector('.tk')!.textContent).toBe('Form.tsx')
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    s.key('Enter')
    expect(s.p.onAsk).toHaveBeenCalledWith(`глянь ${T}`, [expect.objectContaining({ path: '/w/Form.tsx', kind: 'file' })])
  })
})

describe('InputBar: правки после ревью', () => {
  beforeEach(() => {
    invoke.mockReset()
    invoke.mockResolvedValue([])
    resetHistory()
  })

  it('вставка во время листания истории — выход из истории: ↑ и ↓ возвращают вставленное', () => {
    pushHistory('a')
    pushHistory('b')
    const s = setup()
    s.key('ArrowUp')
    expect(s.ta.value).toBe('b')
    setSelection(s.ed, 1)
    fireEvent.paste(s.ed, { clipboardData: { getData: () => 'X', types: ['text/plain'], items: [] } })
    expect(s.ta.value).toBe('bX')
    s.key('ArrowUp')
    expect(s.ta.value).toBe('b')
    s.key('ArrowDown')
    expect(s.ta.value).toBe('bX')
  })

  it('`@путь` в режиме Claude работает и при выключенных подсказках путей', async () => {
    invoke.mockImplementation((cmd: string) => Promise.resolve(cmd === 'fs_list' ? [{ name: 'Form.tsx', isDir: false, isSymlink: false }] : []))
    const s = setup({ completions: false, atFiles: true })
    s.set('cat Fo')
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })
    // В оболочке подсказки выключены настройкой.
    expect(invoke).not.toHaveBeenCalledWith('fs_list', expect.anything())
    s.set('claude')
    s.key('Enter')
    s.set('@Fo')
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })
    expect(invoke).toHaveBeenCalledWith('fs_list', expect.objectContaining({ dir: '/w' }))
    expect(s.container.querySelector('.cp')).not.toBeNull()
  })
})
