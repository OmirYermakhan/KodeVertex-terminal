import { act, fireEvent, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PtyHandle, SpawnOptions } from './ptyClient'

const terms: FakeTerminal[] = []

class FakeTerminal {
  /** Все присваивания fontFamily по порядку. */
  fontHistory: unknown[] = []
  options: Record<string, unknown>
  cols = 80
  rows = 24
  unicode = { activeVersion: '6' }
  parser = { registerOscHandler: vi.fn() }
  write = vi.fn()
  dispose = vi.fn()
  focus = vi.fn()
  loadAddon = vi.fn()
  open = vi.fn()
  attachCustomKeyEventHandler = vi.fn()
  hasSelection = () => false
  getSelection = () => ''
  paste = vi.fn()
  onData = vi.fn()
  onResize = vi.fn()
  onScroll = vi.fn()
  onWriteParsed = vi.fn()
  clearTextureAtlas = vi.fn()
  reset = vi.fn()
  refresh = vi.fn()
  /** Строки активного буфера (для заморозки блока). */
  lines: string[] = []
  buffer = ((t: FakeTerminal) => ({
    active: {
      type: 'normal',
      cursorX: 5,
      cursorY: 3,
      baseY: 0,
      viewportY: 0,
      get length() {
        return t.lines.length
      },
      getLine: (i: number) => {
        const l = t.lines[i]
        return l === undefined ? undefined : { translateToString: () => l }
      },
    },
    onBufferChange: vi.fn(),
  }))(this)
  element: HTMLElement | undefined = undefined
  constructor(opts: Record<string, unknown>) {
    const history = this.fontHistory
    this.options = new Proxy({ ...opts }, {
      set(target, key, value) {
        if (key === 'fontFamily') history.push(value)
        target[key as string] = value
        return true
      },
    })
    terms.push(this)
  }
}

const addons: FakeAddon[] = []

class FakeAddon {
  constructor() {
    addons.push(this)
  }
  fit = vi.fn()
  onContextLoss = vi.fn()
  dispose = vi.fn()
}

vi.mock('@xterm/xterm', () => ({ Terminal: FakeTerminal }))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: FakeAddon }))
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: FakeAddon }))
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: FakeAddon }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: FakeAddon }))
const serializeAsHTML = vi.fn(
  () => "<html><body><!--StartFragment--><pre><div style='color: #000000; background-color: #ffffff;'><div><span>out1</span></div><div><span>out2</span></div></div></pre><!--EndFragment--></body></html>",
)
vi.mock('@xterm/addon-serialize', () => ({
  SerializeAddon: class extends FakeAddon {
    serializeAsHTML = serializeAsHTML
  },
}))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }))
vi.mock('@tauri-apps/api/path', () => ({ homeDir: () => Promise.resolve('/h') }))
const invoke = vi.fn()
class FakeChannel<T> {
  onmessage: (m: T) => void
  constructor(onmessage: (m: T) => void) {
    this.onmessage = onmessage
  }
}
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a), Channel: FakeChannel }))

interface PendingSpawn {
  opts: SpawnOptions
  handle: { id: string; write: ReturnType<typeof vi.fn>; resize: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn> }
  resolve: () => void
}
const spawns: PendingSpawn[] = []

vi.mock('./ptyClient', () => ({
  spawnPty: (opts: SpawnOptions) =>
    new Promise<PtyHandle>((res) => {
      const handle = { id: `s${spawns.length}`, write: vi.fn(), resize: vi.fn(), kill: vi.fn() }
      spawns.push({ opts, handle, resolve: () => res(handle) })
    }),
}))

globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
  unobserve() {}
} as unknown as typeof ResizeObserver

const { TerminalPane } = await import('./TerminalPane')
const { useUi } = await import('../ui/uiStore')
const { useSettings } = await import('../settings/store')
const { DEFAULTS, terminalLineHeight } = await import('../settings/settings')
const { codeFontStack } = await import('../theme/fontFamily')
const { runPaneCommand } = await import('../feed/paneCommands')
const { getHistory, resetHistory } = await import('../input/history')
const { useClaudeSessions } = await import('../claude/sessionStore')

const flush = (ms = 0) => new Promise((r) => setTimeout(r, ms))

type OscHandler = (data: string) => boolean
type KeyHandler = (e: KeyboardEvent) => boolean
const oscHandler = (t: FakeTerminal, id: number) =>
  t.parser.registerOscHandler.mock.calls.find((c) => c[0] === id)![1] as OscHandler
const keyHandler = (t: FakeTerminal) => t.attachCustomKeyEventHandler.mock.calls[0][0] as KeyHandler
const textarea = () => document.querySelector<HTMLTextAreaElement>('.in-ta')!
/** Набор в строке ввода: значение и курсор в конце. */
const type = (v: string) => fireEvent.change(textarea(), { target: { value: v, selectionStart: v.length, selectionEnd: v.length } })
const keyIn = (key: string, o: KeyboardEventInit = {}) => fireEvent.keyDown(textarea(), { key, ...o })

function props() {
  return { paneId: 'p', focused: false, onCwd: vi.fn(), onExit: vi.fn(), onFocus: vi.fn() }
}

describe('TerminalPane', () => {
  beforeEach(() => {
    terms.length = 0
    spawns.length = 0
    addons.length = 0
    useUi.setState({ settingsOpen: false })
    useSettings.setState({ settings: { ...DEFAULTS } })
    invoke.mockReset()
    resetHistory()
    useClaudeSessions.setState({ sessions: {} })
  })

  it('фокус в строку ввода при закрытии настроек', () => {
    useUi.setState({ settingsOpen: true })
    render(<TerminalPane {...props()} focused />)
    expect(document.activeElement).not.toBe(textarea())
    act(() => useUi.setState({ settingsOpen: false }))
    expect(document.activeElement).toBe(textarea())
    expect(terms[0].focus).not.toHaveBeenCalled()
  })

  describe('строка ввода', () => {
    async function mounted(focused = true) {
      const r = render(<TerminalPane {...props()} focused={focused} initialCwd="/w" />)
      spawns[0].resolve()
      await flush()
      return { ...r, term: terms[0], write: spawns[0].handle.write }
    }

    it('↵ пишет команду в PTY и добавляет её в историю; ↑ её возвращает', async () => {
      const { write } = await mounted()
      type('ls -la')
      keyIn('Enter')
      expect(write).toHaveBeenCalledWith('ls -la\r')
      expect(textarea().value).toBe('')
      expect(getHistory()).toEqual(['ls -la'])
      keyIn('ArrowUp')
      expect(textarea().value).toBe('ls -la')
    })

    it('многострочная команда уходит одной строкой ZLE (bracketed paste)', async () => {
      const { write } = await mounted()
      type('for i in 1 2\ndo echo $i; done')
      keyIn('Enter')
      expect(write).toHaveBeenCalledWith('\x1b[200~for i in 1 2\ndo echo $i; done\x1b[201~\r')
    })

    it('пустая строка не отправляется', async () => {
      const { write } = await mounted()
      type('   ')
      keyIn('Enter')
      expect(write).not.toHaveBeenCalled()
    })

    it('подсказки путей: `cd Док` → Tab → значение поля `cd Документы/`, в PTY ничего', async () => {
      invoke.mockImplementation(async (cmd: string) =>
        cmd === 'fs_list' ? [{ name: 'Документы', isDir: true, isSymlink: false }] : { kind: 'dir', entries: [], total: 0 },
      )
      const { write } = await mounted()
      await act(async () => {
        type('cd Док')
        await flush(40)
      })
      expect(invoke).toHaveBeenCalledWith('fs_list', { dir: '/w', dirsOnly: true, includeHidden: false })
      expect(document.querySelector('.input-wrap .cp')).not.toBeNull()
      keyIn('Tab')
      expect(textarea().value).toBe('cd Документы/')
      expect(write).not.toHaveBeenCalled()
      // esc при открытом попапе закрывает его.
      await act(async () => await flush(40))
      expect(document.querySelector('.cp')).not.toBeNull()
      keyIn('Escape')
      expect(document.querySelector('.cp')).toBeNull()
    })

    it('↵ на cd в попапе подставляет и выполняет', async () => {
      invoke.mockImplementation(async (cmd: string) =>
        cmd === 'fs_list' ? [{ name: 'src', isDir: true, isSymlink: false }] : { kind: 'dir', entries: [], total: 0 },
      )
      const { write } = await mounted()
      await act(async () => {
        type('cd sr')
        await flush(40)
      })
      keyIn('Enter')
      expect(write).toHaveBeenCalledWith('cd src\r')
    })

    it('cwd подсказок — из OSC 7', async () => {
      invoke.mockResolvedValue([{ name: 'src', isDir: true, isSymlink: false }])
      const { term } = await mounted()
      await act(async () => {
        oscHandler(term, 7)('file://host/q')
        type('cd sr')
        await flush(40)
      })
      expect(invoke).toHaveBeenCalledWith('fs_list', { dir: '/q', dirsOnly: true, includeHidden: false })
    })

    it('фоновая панель и выключенные подсказки — без попапа', async () => {
      invoke.mockResolvedValue([{ name: 'src', isDir: true, isSymlink: false }])
      useSettings.setState({ settings: { ...DEFAULTS, pathCompletions: false } })
      await mounted()
      await act(async () => {
        type('cd sr')
        await flush(40)
      })
      expect(invoke).not.toHaveBeenCalledWith('fs_list', expect.anything())
      expect(document.querySelector('.cp')).toBeNull()
    })

    it('⇧↵ не отправляет (перенос строки — поведение поля)', async () => {
      const { write } = await mounted()
      type('echo a')
      const ev = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true })
      textarea().dispatchEvent(ev)
      expect(ev.defaultPrevented).toBe(false)
      expect(write).not.toHaveBeenCalled()
    })

    it('⌃C очищает строку; ⌃L очищает ленту, id новых блоков не повторяются', async () => {
      const { term } = await mounted()
      type('abc')
      keyIn('c', { ctrlKey: true })
      expect(textarea().value).toBe('')
      for (const c of ['a', 'b']) {
        act(() => void oscHandler(term, 133)('C;' + btoa(c)))
        act(() => void oscHandler(term, 133)('D;0'))
      }
      const ids = () => Array.from(document.querySelectorAll('.feed [data-block-id]')).map((e) => e.getAttribute('data-block-id'))
      const before = ids()
      expect(before).toHaveLength(2)
      keyIn('l', { ctrlKey: true })
      expect(ids()).toEqual([])
      act(() => void oscHandler(term, 133)('C;' + btoa('c')))
      act(() => void oscHandler(term, 133)('D;0'))
      expect(ids()).toHaveLength(1)
      expect(before).not.toContain(ids()[0])
    })

    describe('Claude', () => {
      type Call = [string, Record<string, unknown>]
      const calls = () => invoke.mock.calls as Call[]
      const startArgs = () => calls().find((c) => c[0] === 'claude_start')![1] as {
        onLine: { onmessage: (l: string) => void }
        onExit: { onmessage: (e: { code: number | null; stderr: string }) => void }
      }
      function claudeOk() {
        invoke.mockImplementation(async (cmd: string) => (cmd === 'claude_start' ? 'c1' : undefined))
      }

      it('⌘↵: карточка «Вы» сразу, claude_start в cwd панели, затем claude_send; второй — только send', async () => {
        claudeOk()
        await mounted()
        type('что тут?')
        keyIn('Enter', { metaKey: true })
        expect(textarea().value).toBe('')
        expect(document.querySelector('.you')?.textContent).toContain('что тут?')
        await act(async () => await flush())
        const names = calls().map((c) => c[0]).filter((n) => n.startsWith('claude'))
        expect(names).toEqual(['claude_start', 'claude_send'])
        expect(calls().find((c) => c[0] === 'claude_start')![1]).toMatchObject({ cwd: '/w', resume: null })
        expect(calls().find((c) => c[0] === 'claude_send')![1]).toEqual({ id: 'c1', text: 'что тут?' })
        // Вопрос Claude не попадает в историю команд.
        expect(getHistory()).toEqual([])

        type('ещё')
        keyIn('Enter', { metaKey: true })
        await act(async () => await flush())
        expect(calls().map((c) => c[0]).filter((n) => n.startsWith('claude'))).toEqual(['claude_start', 'claude_send', 'claude_send'])
      })

      it('ответы Claude — в той же ленте, по времени: блок, вопрос, ответ, следующий блок', async () => {
        claudeOk()
        const { term } = await mounted()
        act(() => void oscHandler(term, 133)('C;' + btoa('ls')))
        act(() => void oscHandler(term, 133)('D;0'))
        type('вопрос')
        keyIn('Enter', { metaKey: true })
        await act(async () => await flush())
        act(() =>
          startArgs().onLine.onmessage(
            JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4', content: [{ type: 'text', text: 'ответ' }] } }),
          ),
        )
        act(() => void oscHandler(term, 133)('C;' + btoa('pwd')))
        act(() => void oscHandler(term, 133)('D;0'))
        const order = Array.from(document.querySelectorAll('.feed > .blk, .feed > .you, .feed > .card')).map((e) =>
          e.classList.contains('blk') ? 'blk:' + e.querySelector('.cmd')!.textContent : e.classList.contains('you') ? 'you' : 'card',
        )
        expect(order).toEqual(['blk:ls', 'you', 'card', 'blk:pwd'])
        expect(useClaudeSessions.getState().sessions.p.state.agents.length).toBeGreaterThan(0)
      })

      it('выход claude с ошибкой — карточка ошибки с хвостом stderr; следующий ⌘↵ перезапускает с --resume', async () => {
        claudeOk()
        await mounted()
        type('a')
        keyIn('Enter', { metaKey: true })
        await act(async () => await flush())
        act(() => startArgs().onLine.onmessage(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'S1' })))
        act(() => startArgs().onExit.onmessage({ code: 1, stderr: 'boom\n' }))
        expect(document.querySelector('.cerr')?.textContent).toContain('boom')
        expect(useClaudeSessions.getState().sessions.p.state.busy).toBe(false)
        invoke.mockClear()
        type('b')
        keyIn('Enter', { metaKey: true })
        await act(async () => await flush())
        expect(calls().find((c) => c[0] === 'claude_start')![1]).toMatchObject({ resume: 'S1' })
      })

      it('claude не найден — карточка ошибки с текстом', async () => {
        invoke.mockImplementation(async (cmd: string) => {
          if (cmd === 'claude_start') throw 'Claude Code не найден. Установите: npm i -g @anthropic-ai/claude-code'
        })
        await mounted()
        type('a')
        keyIn('Enter', { metaKey: true })
        await act(async () => await flush())
        expect(document.querySelector('.cerr')?.textContent).toContain('Claude Code не найден')
        expect(calls().some((c) => c[0] === 'claude_send')).toBe(false)
      })

      it('⌃C при занятом Claude — claude_interrupt, строка не очищается; выход после него — не ошибка', async () => {
        claudeOk()
        await mounted()
        type('a')
        keyIn('Enter', { metaKey: true })
        await act(async () => await flush())
        type('draft')
        keyIn('c', { ctrlKey: true })
        expect(invoke).toHaveBeenCalledWith('claude_interrupt', { id: 'c1' })
        expect(textarea().value).toBe('draft')
        act(() => startArgs().onExit.onmessage({ code: 130, stderr: '' }))
        expect(document.querySelector('.cerr')).toBeNull()
        expect(useClaudeSessions.getState().sessions.p.state.busy).toBe(false)
      })

      it('закрытие панели останавливает процесс claude', async () => {
        claudeOk()
        const { unmount } = await mounted()
        type('a')
        keyIn('Enter', { metaKey: true })
        await act(async () => await flush())
        unmount()
        expect(invoke).toHaveBeenCalledWith('claude_stop', { id: 'c1' })
        expect(useClaudeSessions.getState().sessions.p).toBeUndefined()
      })
    })
  })

  it('kills a session that resolves after unmount and ignores its output/exit', async () => {
    const p = props()
    const { unmount } = render(<TerminalPane {...p} />)
    unmount()
    spawns[0].resolve()
    await flush()
    expect(spawns[0].handle.kill).toHaveBeenCalled()
    spawns[0].opts.onData(new Uint8Array([1]))
    spawns[0].opts.onExit(null)
    expect(terms[0].write).not.toHaveBeenCalled()
    expect(p.onExit).not.toHaveBeenCalled()
  })

  it('does not report exit caused by its own kill on unmount', async () => {
    const p = props()
    const { unmount } = render(<TerminalPane {...p} />)
    spawns[0].resolve()
    await flush()
    unmount()
    expect(spawns[0].handle.kill).toHaveBeenCalled()
    spawns[0].opts.onExit(0)
    expect(p.onExit).not.toHaveBeenCalled()
  })

  it('reports a real exit while mounted', async () => {
    const p = props()
    render(<TerminalPane {...p} />)
    spawns[0].resolve()
    await flush()
    spawns[0].opts.onData(new Uint8Array([104]))
    spawns[0].opts.onExit(0)
    expect(terms[0].write).toHaveBeenCalledWith(new Uint8Array([104]))
    expect(p.onExit).toHaveBeenCalledTimes(1)
  })

  it('syncs the size that changed while pty_spawn was in flight', async () => {
    render(<TerminalPane {...props()} />)
    expect(spawns[0].opts).toMatchObject({ cols: 80, rows: 24 })
    const term = terms[0]
    term.cols = 120
    term.rows = 40
    const onResize = term.onResize.mock.calls[0][0] as (s: { cols: number; rows: number }) => void
    onResize({ cols: 120, rows: 40 }) // dropped: no handle yet
    spawns[0].resolve()
    await flush()
    expect(spawns[0].handle.resize).toHaveBeenCalledWith(120, 40)
  })

  it('does not kill a session that already exited on its own', async () => {
    const p = props()
    const { unmount } = render(<TerminalPane {...p} />)
    spawns[0].resolve()
    await flush()
    spawns[0].opts.onExit(0)
    unmount()
    expect(spawns[0].handle.kill).not.toHaveBeenCalled()
  })

  it('re-measures the font after it finishes loading, then fits', async () => {
    let loaded!: () => void
    const load = vi.fn(() => new Promise<void>((r) => (loaded = r)))
    Object.defineProperty(document, 'fonts', { value: { load }, configurable: true })
    try {
      render(<TerminalPane {...props()} />)
      const term = terms[0]
      const fit = addons[0].fit
      act(() => useSettings.setState({ settings: { ...DEFAULTS, codeFont: 'Fira Code' } }))
      const stack = codeFontStack('Fira Code')
      expect(load).toHaveBeenLastCalledWith(`${DEFAULTS.codeSize}px ${stack}`)
      term.fontHistory.length = 0
      fit.mockClear()
      loaded()
      await flush()
      // Семейство меняется туда и обратно — xterm перемеряет ячейку.
      expect(term.fontHistory).toEqual(['monospace', stack])
      expect(term.clearTextureAtlas).toHaveBeenCalled()
      expect(fit).toHaveBeenCalled()
    } finally {
      delete (document as { fonts?: unknown }).fonts
    }
  })

  describe('лента', () => {
    const b64 = (x: string) => btoa(x)
    async function mounted(focused = true) {
      const r = render(<TerminalPane {...props()} focused={focused} initialCwd="/w" />)
      spawns[0].resolve()
      await flush()
      return { ...r, term: terms[0] }
    }
    const osc133 = (term: FakeTerminal, data: string) => act(() => void oscHandler(term, 133)(data))
    const bufferChange = (term: FakeTerminal, type: string) =>
      act(() => (term.buffer.onBufferChange.mock.calls[0][0] as (b: { type: string }) => void)({ type }))
    const host = () => document.querySelector('.live-host')!

    it('без команды xterm стоит в невидимой парковке ленты', async () => {
      await mounted()
      expect(host().closest('.feed-park')).not.toBeNull()
      expect(document.querySelector('.blk.run')).toBeNull()
    })

    it('start: reset и running-блок с живым терминалом; end: замороженный HTML без обёртки', async () => {
      const { term } = await mounted()
      osc133(term, 'C;' + b64('ls -la'))
      expect(term.reset).toHaveBeenCalledTimes(1)
      const blk = document.querySelector('.blk.run')!
      expect(blk.querySelector('.cmd')!.textContent).toBe('ls -la')
      expect(blk.querySelector('[data-testid="live-block"]')!.contains(host())).toBe(true)
      expect(term.focus).toHaveBeenCalled()

      term.lines = ['out1', 'out2', '', '']
      osc133(term, 'D;0')
      expect(serializeAsHTML).toHaveBeenLastCalledWith({
        includeGlobalBackground: false,
        range: { startLine: 0, endLine: 1, startCol: 0 },
      })
      expect(document.querySelector('.blk.run')).toBeNull()
      const out = document.querySelector('.blk .out')!
      expect(out.innerHTML).toBe('<div><span>out1</span></div><div><span>out2</span></div>')
      expect(host().closest('.feed-park')).not.toBeNull()
    })

    it('ненулевой код выхода — блок .err и «exit N»', async () => {
      const { term } = await mounted()
      osc133(term, 'C;' + b64('false'))
      osc133(term, 'D;1')
      const blk = document.querySelector('.blk')!
      expect(blk).toHaveClass('err')
      expect(blk.querySelector('.exit')!.textContent).toBe('exit 1')
    })

    it('alt screen: xterm поверх панели с фокусом, после выхода — обратно в блок', async () => {
      const { term } = await mounted()
      osc133(term, 'C;' + b64('vim'))
      term.focus.mockClear()
      bufferChange(term, 'alternate')
      const overlay = document.querySelector('[data-testid="live-overlay"]')!
      expect(overlay.contains(host())).toBe(true)
      expect(document.querySelector('[data-testid="live-block"]')).toBeNull()
      expect(term.focus).toHaveBeenCalled()
      bufferChange(term, 'normal')
      expect(document.querySelector('[data-testid="live-overlay"]')).toBeNull()
      expect(document.querySelector('[data-testid="live-block"]')!.contains(host())).toBe(true)
    })

    it('⌘↑/⌘↓ выбирают блок, ⌘⇧C копирует его вывод текстом', async () => {
      const writeText = vi.fn(() => Promise.resolve())
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
      const { term } = await mounted()
      for (const c of ['a', 'b']) {
        osc133(term, 'C;' + b64(c))
        term.lines = ['out1', 'out2']
        osc133(term, 'D;0')
      }
      const blocks = () => Array.from(document.querySelectorAll('.blk:not(.feed-park .blk)'))
      act(() => runPaneCommand('p', 'blockPrev'))
      expect(blocks().map((b) => b.classList.contains('sel'))).toEqual([false, true])
      act(() => runPaneCommand('p', 'blockPrev'))
      expect(blocks().map((b) => b.classList.contains('sel'))).toEqual([true, false])
      act(() => runPaneCommand('p', 'blockCopy'))
      expect(writeText).toHaveBeenCalledWith('out1\nout2')
      act(() => runPaneCommand('p', 'blockNext'))
      act(() => runPaneCommand('p', 'blockNext'))
      expect(document.querySelector('.blk.sel')).toBeNull()
    })

    it('хоткеи блоков не уходят в xterm', async () => {
      const { term } = await mounted()
      const k = (o: KeyboardEventInit) => keyHandler(term)(new KeyboardEvent('keydown', o))
      expect(k({ code: 'ArrowUp', key: 'ArrowUp', metaKey: true })).toBe(false)
      expect(k({ code: 'KeyC', key: 'C', metaKey: true, shiftKey: true })).toBe(false)
    })

    it('пока идёт команда, строка ввода неактивна; после конца фокус возвращается в неё', async () => {
      const { term } = await mounted()
      expect(document.activeElement).toBe(textarea())
      osc133(term, 'C;' + b64('ls'))
      expect(textarea()).toBeDisabled()
      osc133(term, 'D;0')
      expect(host().closest('.feed-park')).not.toBeNull()
      expect(textarea()).not.toBeDisabled()
      expect(document.activeElement).toBe(textarea())
    })

    it('фоновая панель фокус не забирает', async () => {
      const { term } = await mounted(false)
      osc133(term, 'C;' + b64('ls'))
      osc133(term, 'D;0')
      expect(term.focus).not.toHaveBeenCalled()
    })

    it('вывод в том же куске, что и C, сразу растит живой блок', async () => {
      const { term } = await mounted()
      const parsed = term.onWriteParsed.mock.calls[0][0] as () => void
      act(() => {
        // Один write: C, затем вывод — onWriteParsed приходит до коммита React.
        oscHandler(term, 133)('C;' + b64('echo hi; sleep 5'))
        term.buffer.active.cursorY = 2
        parsed()
      })
      const slot = document.querySelector<HTMLElement>('[data-testid="live-block"]')!
      const cell = DEFAULTS.codeSize * terminalLineHeight(DEFAULTS)
      expect(slot.style.height).toBe(`${Math.ceil(3 * cell)}px`)
    })

    it('конец команды при активном alt screen — содержимое alt не замораживается', async () => {
      const { term } = await mounted()
      osc133(term, 'C;' + b64('vim'))
      bufferChange(term, 'alternate')
      term.buffer.active.type = 'alternate'
      term.lines = ['~', '~']
      serializeAsHTML.mockClear()
      osc133(term, 'D;0')
      expect(serializeAsHTML).not.toHaveBeenCalled()
      expect(document.querySelector('.blk .out')).toBeNull()
    })

    it('клик по кнопке ленты фокус не трогает; клик по ленте — в строку ввода, во время команды — в xterm', async () => {
      const { term } = await mounted()
      const feed = document.querySelector('.feed')!
      const btn = document.createElement('button')
      feed.appendChild(btn)
      btn.focus()
      fireEvent.mouseUp(btn)
      expect(document.activeElement).toBe(btn)
      fireEvent.mouseUp(feed)
      expect(document.activeElement).toBe(textarea())
      osc133(term, 'C;' + b64('sleep 9'))
      term.focus.mockClear()
      fireEvent.mouseUp(feed)
      expect(term.focus).toHaveBeenCalled()
      btn.remove()
    })
  })
})
