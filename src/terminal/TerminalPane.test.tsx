import { act, render } from '@testing-library/react'
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
  clearTextureAtlas = vi.fn()
  buffer = { active: { cursorX: 5, cursorY: 3, baseY: 0, viewportY: 0 } }
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
})
