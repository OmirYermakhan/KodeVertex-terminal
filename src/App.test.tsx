import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { leaves } from './layout/paneTree'
import { initialTabsState, useTabs } from './layout/tabsStore'
import { DEFAULTS } from './settings/settings'
import { useSettings } from './settings/store'
import { useUi } from './ui/uiStore'

// xterm needs a real canvas/layout; the pane itself is checked manually in the app.
vi.mock('./terminal/TerminalPane', () => ({ TerminalPane: () => null }))

const update = vi.fn()
const paneCount = () => {
  const s = useTabs.getState()
  return leaves(s.tabs.find((t) => t.id === s.active)!.tree).length
}
const press = (code: string, extra: Partial<KeyboardEventInit> = {}) =>
  fireEvent.keyDown(window, { code, metaKey: true, ...extra })

describe('App', () => {
  beforeEach(() => {
    update.mockClear()
    useTabs.setState(initialTabsState())
    useUi.setState({ settingsOpen: false })
    useSettings.setState({ settings: { ...DEFAULTS }, update, loaded: false, load: async () => {} })
  })

  it('renders tabbar, panes and statusbar zones', () => {
    render(<App />)
    expect(screen.getByTestId('tabbar')).toBeInTheDocument()
    expect(screen.getByTestId('panes')).toBeInTheDocument()
    expect(screen.getByTestId('statusbar')).toBeInTheDocument()
  })

  it('ignores auto-repeat for ⌘W but closes on a real press', () => {
    render(<App />)
    act(() => useTabs.getState().split('row'))
    expect(paneCount()).toBe(2)
    press('KeyW', { repeat: true })
    expect(paneCount()).toBe(2)
    press('KeyW')
    expect(paneCount()).toBe(1)
  })

  it('auto-repeat still changes the font size', () => {
    render(<App />)
    press('Equal', { repeat: true })
    press('Minus', { repeat: true })
    expect(update).toHaveBeenCalledTimes(2)
  })

  it('while settings are open only ⌘, works and Esc closes them', () => {
    render(<App />)
    act(() => useTabs.getState().split('row'))
    act(() => useUi.setState({ settingsOpen: true }))
    press('KeyW')
    press('KeyT')
    expect(paneCount()).toBe(2)
    expect(useTabs.getState().tabs).toHaveLength(1)
    press('Comma')
    expect(useUi.getState().settingsOpen).toBe(true)
    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' })
    expect(useUi.getState().settingsOpen).toBe(false)
  })

  it('shows the stalled-shell message and reopens a tab', () => {
    useSettings.setState({ loaded: true })
    useTabs.setState({ tabs: [], active: '', respawns: [] })
    render(<App />)
    expect(screen.getByRole('alert')).toHaveTextContent('Оболочка завершается сразу после запуска')
    fireEvent.click(screen.getByRole('button', { name: 'Открыть снова' }))
    expect(useTabs.getState().tabs).toHaveLength(1)
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
