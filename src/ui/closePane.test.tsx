import { act, fireEvent, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PtyHandle, SpawnOptions } from '../terminal/ptyClient'

// ⌘W по настоящему пути: keydown в фокусном элементе панели → keymap → действие.
const terms: FakeTerminal[] = []
class FakeTerminal {
  options: Record<string, unknown>
  cols = 80
  rows = 24
  unicode = { activeVersion: '6' }
  parser = { registerOscHandler: vi.fn() }
  write = vi.fn()
  dispose = vi.fn()
  textarea = document.createElement('textarea')
  focus = vi.fn(() => this.textarea.focus())
  loadAddon = vi.fn()
  open = vi.fn((host: HTMLElement) => host.appendChild(this.textarea))
  keyHandler: ((e: KeyboardEvent) => boolean) | null = null
  attachCustomKeyEventHandler = vi.fn((h: (e: KeyboardEvent) => boolean) => {
    this.keyHandler = h
  })
  hasSelection = () => false
  getSelection = () => ''
  paste = vi.fn()
  dataCb: ((d: string) => void) | null = null
  onData = vi.fn((cb: (d: string) => void) => {
    this.dataCb = cb
  })
  onResize = vi.fn()
  onScroll = vi.fn()
  onWriteParsed = vi.fn()
  clearTextureAtlas = vi.fn()
  reset = vi.fn()
  refresh = vi.fn()
  buffer = {
    active: { type: 'normal', cursorX: 0, cursorY: 0, baseY: 0, viewportY: 0, length: 0, getLine: () => undefined },
    onBufferChange: vi.fn(),
  }
  element: HTMLElement | undefined = undefined
  constructor(opts: Record<string, unknown>) {
    this.options = { ...opts }
    // Как xterm: клавиша в textarea → свой обработчик → байты в PTY.
    this.textarea.addEventListener('keydown', (e) => {
      if (this.keyHandler && !this.keyHandler(e)) return
      if (e.key.length === 1) this.dataCb?.(e.key)
    })
    terms.push(this)
  }
}
class FakeAddon {
  fit = vi.fn()
  onContextLoss = vi.fn()
  dispose = vi.fn()
  serializeAsHTML = vi.fn(() => '')
}
vi.mock('@xterm/xterm', () => ({ Terminal: FakeTerminal }))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: FakeAddon }))
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: FakeAddon }))
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: FakeAddon }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: FakeAddon }))
vi.mock('@xterm/addon-serialize', () => ({ SerializeAddon: FakeAddon }))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }))
vi.mock('@tauri-apps/api/path', () => ({ homeDir: () => Promise.resolve('/h') }))
vi.mock('@tauri-apps/api/event', () => ({ listen: () => Promise.resolve(() => {}) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve(null)), Channel: class {} }))
const handles: { write: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn> }[] = []
vi.mock('../terminal/ptyClient', () => ({
  spawnPty: (opts: SpawnOptions) => {
    const h = { id: `s${handles.length}`, mark: 'm', write: vi.fn(), resize: vi.fn(), kill: vi.fn() }
    handles.push(h)
    opts.onSpawn?.(h)
    return Promise.resolve(h as PtyHandle)
  },
}))
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
  unobserve() {}
} as unknown as typeof ResizeObserver

const { default: App } = await import('../App')
const { useTabs, initialTabsState } = await import('../layout/tabsStore')
const { leaves } = await import('../layout/paneTree')
const { useSettings } = await import('../settings/store')
const { DEFAULTS } = await import('../settings/settings')
const { useUi } = await import('./uiStore')
const { CLOSE_PANE_TITLE } = await import('./PaneView')

const flush = () => act(() => new Promise((r) => setTimeout(r, 0)))
const activeTab = () => {
  const s = useTabs.getState()
  return s.tabs.find((t) => t.id === s.active)!
}
const panes = () => leaves(activeTab().tree)
const paneEl = (id: string) => document.querySelector<HTMLElement>(`.pane[data-pane-id="${id}"]`)!
const inputOf = (id: string) => paneEl(id).querySelector<HTMLElement>('.in-ta')!
/** Настоящее нажатие: событие уходит в элемент с фокусом и всплывает. */
const cmdW = () => fireEvent.keyDown(document.activeElement ?? document.body, { key: 'w', code: 'KeyW', metaKey: true })

describe('⌘W в сплите', () => {
  beforeEach(() => {
    terms.length = 0
    handles.length = 0
    useTabs.setState(initialTabsState())
    useUi.setState({ settingsOpen: false, agentsHidden: false })
    useSettings.setState({ settings: { ...DEFAULTS }, loaded: true, load: async () => {}, update: vi.fn() })
  })

  it('закрывает панель, в строке ввода которой стоит фокус', async () => {
    render(<App />)
    await flush()
    const [a] = panes()
    act(() => useTabs.getState().split('row'))
    await flush()
    const [, b] = panes()
    expect(document.activeElement).toBe(inputOf(b))
    cmdW()
    await flush()
    expect(panes()).toEqual([a])
  })

  it('закрывает панель, по которой щёлкнули (фокус в её строке ввода)', async () => {
    render(<App />)
    await flush()
    const [a] = panes()
    act(() => useTabs.getState().split('row'))
    await flush()
    const [, b] = panes()
    const feed = paneEl(a).querySelector<HTMLElement>('.feed') ?? paneEl(a)
    fireEvent.pointerDown(feed, { button: 0 })
    fireEvent.mouseUp(feed)
    expect(document.activeElement).toBe(inputOf(a))
    cmdW()
    await flush()
    expect(panes()).toEqual([b])
  })

  it('щелчок по кнопке ленты делает панель фокусной, хотя фокус элемента не переносит (WebKit)', async () => {
    render(<App />)
    await flush()
    const [a] = panes()
    act(() => useTabs.getState().split('row'))
    await flush()
    const [, b] = panes()
    expect(document.activeElement).toBe(inputOf(b))
    // В WebKit щелчок по <button> фокус не переносит: pointerdown без focusin.
    const btn = document.createElement('button')
    paneEl(a).querySelector('.feed')!.appendChild(btn)
    fireEvent.pointerDown(btn, { button: 0 })
    expect(activeTab().focused).toBe(a)
    cmdW()
    await flush()
    expect(panes()).toEqual([b])
  })

  it('фокус в живом xterm (идёт команда): ⌘W закрывает панель и не пишет в PTY', async () => {
    render(<App />)
    await flush()
    const [a] = panes()
    act(() => useTabs.getState().split('row'))
    await flush()
    const t = terms[1]
    const osc = t.parser.registerOscHandler.mock.calls.find((c) => c[0] === 133)![1] as (d: string) => boolean
    act(() => void osc('C;' + btoa('vim') + ';kv=m'))
    await flush()
    expect(document.activeElement).toBe(t.textarea)
    cmdW()
    await flush()
    expect(panes()).toEqual([a])
    expect(handles[1].write).not.toHaveBeenCalled()
    expect(handles[1].kill).toHaveBeenCalled()
  })

  it('✕ есть только в сплите и закрывает свою панель; фокус остаётся в своей', async () => {
    const { queryAllByRole } = render(<App />)
    await flush()
    const xs = () => queryAllByRole('button', { name: CLOSE_PANE_TITLE })
    expect(xs()).toHaveLength(0)
    const [a] = panes()
    act(() => useTabs.getState().split('row'))
    await flush()
    const [, b] = panes()
    expect(xs()).toHaveLength(2)
    fireEvent.click(paneEl(a).parentElement!.querySelector('.pane-x')!)
    await flush()
    expect(panes()).toEqual([b])
    expect(activeTab().focused).toBe(b)
    expect(xs()).toHaveLength(0)
  })

  it('⌘W в последней панели последней вкладки — новая пустая вкладка, окно живёт', async () => {
    render(<App />)
    await flush()
    const old = activeTab().id
    cmdW()
    await flush()
    const s = useTabs.getState()
    expect(s.tabs).toHaveLength(1)
    expect(s.tabs[0].id).not.toBe(old)
    expect(document.querySelectorAll('.pane')).toHaveLength(1)
  })
})
