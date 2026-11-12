import { act, render } from '@testing-library/react'
import { Profiler } from 'react'
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
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))

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
const { DEFAULTS } = await import('../settings/settings')
const { codeFontStack } = await import('../theme/fontFamily')
const { runPaneCommand } = await import('../feed/paneCommands')

const flush = (ms = 0) => new Promise((r) => setTimeout(r, ms))

type OscHandler = (data: string) => boolean
type KeyHandler = (e: KeyboardEvent) => boolean
const oscHandler = (t: FakeTerminal, id: number) =>
  t.parser.registerOscHandler.mock.calls.find((c) => c[0] === id)![1] as OscHandler
const keyHandler = (t: FakeTerminal) => t.attachCustomKeyEventHandler.mock.calls[0][0] as KeyHandler

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

  it('returns focus to the focused terminal when settings close', () => {
    useUi.setState({ settingsOpen: true })
    render(<TerminalPane {...props()} focused />)
    const term = terms[0]
    expect(term.focus).not.toHaveBeenCalled()
    act(() => useUi.setState({ settingsOpen: false }))
    expect(term.focus).toHaveBeenCalledTimes(1)
  })

  it('routes OSC 6973 to the completion popup and eats its keys before xterm', async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === 'fs_list'
        ? [{ name: 'src', isDir: true, isSymlink: false }]
        : { kind: 'dir', entries: [], total: 0 },
    )
    render(<TerminalPane {...props()} focused initialCwd="/p" />)
    spawns[0].resolve()
    await flush()
    const term = terms[0]
    const onKey = keyHandler(term)
    const enter = () => new KeyboardEvent('keydown', { key: 'Enter', cancelable: true })
    // Попап закрыт — ↵ уходит в xterm.
    expect(onKey(enter())).toBe(true)
    await act(async () => {
      oscHandler(term, 6973)('5;cd sr')
      await flush(40)
    })
    expect(invoke).toHaveBeenCalledWith('fs_list', { dir: '/p', dirsOnly: true, includeHidden: false })
    expect(document.querySelector('.cp')).not.toBeNull()
    const ev = enter()
    let passed = true
    act(() => void (passed = onKey(ev)))
    expect(passed).toBe(false)
    expect(ev.defaultPrevented).toBe(true)
    expect(spawns[0].handle.write).toHaveBeenCalledWith('\x7f\x7fsrc\r')
    expect(document.querySelector('.cp')).toBeNull()
  })

  it('uses the cwd from OSC 7 for completions', async () => {
    invoke.mockResolvedValue([{ name: 'src', isDir: true, isSymlink: false }])
    render(<TerminalPane {...props()} focused initialCwd="/p" />)
    const term = terms[0]
    await act(async () => {
      oscHandler(term, 7)('file://host/q')
      oscHandler(term, 6973)('5;cd sr')
      await flush(40)
    })
    expect(invoke).toHaveBeenCalledWith('fs_list', { dir: '/q', dirsOnly: true, includeHidden: false })
  })

  async function openPopup(term: FakeTerminal) {
    await act(async () => {
      oscHandler(term, 6973)('5;cd sr')
      await flush(40)
    })
  }
  const listing = async (cmd: string) =>
    cmd === 'fs_list' ? [{ name: 'src', isDir: true, isSymlink: false }] : { kind: 'dir', entries: [], total: 0 }

  it('ignores completion reports in an unfocused pane', async () => {
    invoke.mockImplementation(listing)
    render(<TerminalPane {...props()} initialCwd="/p" />)
    await openPopup(terms[0])
    expect(invoke).not.toHaveBeenCalled()
    expect(document.querySelector('.cp')).toBeNull()
  })

  it('closes the popup when the pane loses focus or settings open', async () => {
    invoke.mockImplementation(listing)
    const p = props()
    const { rerender } = render(<TerminalPane {...p} focused initialCwd="/p" />)
    const term = terms[0]
    await openPopup(term)
    expect(document.querySelector('.cp')).not.toBeNull()
    rerender(<TerminalPane {...p} focused={false} initialCwd="/p" />)
    expect(document.querySelector('.cp')).toBeNull()
    rerender(<TerminalPane {...p} focused initialCwd="/p" />)
    await openPopup(term)
    expect(document.querySelector('.cp')).not.toBeNull()
    act(() => useUi.setState({ settingsOpen: true }))
    expect(document.querySelector('.cp')).toBeNull()
  })

  it('ignores reports when path completions are off and closes an open popup on toggle', async () => {
    invoke.mockImplementation(listing)
    useSettings.setState({ settings: { ...DEFAULTS, pathCompletions: false } })
    render(<TerminalPane {...props()} focused initialCwd="/p" />)
    const term = terms[0]
    await openPopup(term)
    expect(invoke).not.toHaveBeenCalled()
    expect(document.querySelector('.cp')).toBeNull()
    act(() => useSettings.setState({ settings: { ...DEFAULTS, pathCompletions: true } }))
    await openPopup(term)
    expect(document.querySelector('.cp')).not.toBeNull()
    act(() => useSettings.setState({ settings: { ...DEFAULTS, pathCompletions: false } }))
    expect(document.querySelector('.cp')).toBeNull()
    expect(keyHandler(term)(new KeyboardEvent('keydown', { key: 'Enter' }))).toBe(true)
  })

  it('scroll and resize do not re-render the pane while the popup is closed', async () => {
    invoke.mockImplementation(listing)
    const onRender = vi.fn()
    render(
      <Profiler id="pane" onRender={onRender}>
        <TerminalPane {...props()} focused initialCwd="/p" />
      </Profiler>,
    )
    const term = terms[0]
    const onScroll = term.onScroll.mock.calls[0][0] as () => void
    const onResize = term.onResize.mock.calls[1][0] as () => void
    await act(async () => await flush())
    onRender.mockClear()
    act(() => {
      for (let i = 0; i < 5; i++) onScroll()
      onResize()
    })
    expect(onRender).not.toHaveBeenCalled()
    await openPopup(term)
    onRender.mockClear()
    act(() => onScroll())
    expect(onRender).toHaveBeenCalled()
  })

  it('hides and closes the popup when the cursor row scrolls out of view', async () => {
    invoke.mockImplementation(listing)
    render(<TerminalPane {...props()} focused initialCwd="/p" />)
    const term = terms[0]
    await openPopup(term)
    expect(document.querySelector('.cp')).not.toBeNull()
    term.buffer.active.baseY = 100
    term.buffer.active.viewportY = 50 // курсор на 53 строки ниже видимой области
    const onScroll = term.onScroll.mock.calls[0][0] as () => void
    act(() => onScroll())
    expect(document.querySelector('.cp')).toBeNull()
    expect(keyHandler(term)(new KeyboardEvent('keydown', { key: 'Enter' }))).toBe(true)
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
  })
})
