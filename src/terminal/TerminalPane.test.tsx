import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PtyHandle, SpawnOptions } from './ptyClient'

const terms: FakeTerminal[] = []

class FakeTerminal {
  options: Record<string, unknown> = {}
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
  constructor(opts: Record<string, unknown>) {
    this.options = { ...opts }
    terms.push(this)
  }
}

class FakeAddon {
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

const flush = () => new Promise((r) => setTimeout(r, 0))

function props() {
  return { paneId: 'p', focused: false, onCwd: vi.fn(), onExit: vi.fn(), onFocus: vi.fn() }
}

describe('TerminalPane', () => {
  beforeEach(() => {
    terms.length = 0
    spawns.length = 0
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
})
