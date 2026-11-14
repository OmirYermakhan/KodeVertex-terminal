import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { leaves } from './layout/paneTree'
import { initialTabsState, useTabs } from './layout/tabsStore'
import { DEFAULTS } from './settings/settings'
import { useSettings } from './settings/store'
import { useUi } from './ui/uiStore'
import { useProject } from './project/store'

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

  it('полоса слева видна всегда; ⌥⌘1 открывает «Проект», повтор — скрывает', () => {
    useProject.setState({ tool: null, tabs: [], active: 0 })
    render(<App />)
    expect(document.querySelector('.stripe')).toBeInTheDocument()
    expect(screen.queryByTestId('toolwindow')).toBeNull()
    press('Digit1', { altKey: true })
    expect(screen.getByTestId('toolwindow')).toBeInTheDocument()
    expect(paneCount()).toBe(1)
    press('Digit1', { altKey: true })
    expect(screen.queryByTestId('toolwindow')).toBeNull()
  })

  it('просмотр справа от панелей; при вкладке изменений панели скрыты как неактивная вкладка и доводят анимации при возврате', () => {
    useProject.setState({ tool: null, tabs: [], active: 0 })
    useSettings.setState({ loaded: true })
    render(<App />)
    const id = useTabs.getState().active
    const host = screen.getByTestId(`tab-${id}`)
    expect(screen.queryByTestId('viewer')).toBeNull()
    act(() => useProject.setState({ tabs: [{ kind: 'file', rel: 'a.kt' }], active: 0 }))
    expect(screen.getByTestId('viewer')).toBeInTheDocument()
    expect(host.style.display).toBe('block')
    const inTab = document.createElement('div')
    host.appendChild(inTab)
    const appear = { animationName: 'kv-in', effect: { target: inTab }, finish: vi.fn() }
    const doc = document as unknown as { getAnimations?: () => unknown[] }
    doc.getAnimations = () => [appear]
    try {
      act(() => useProject.setState({ tabs: [{ kind: 'file', rel: 'a.kt' }, { kind: 'diff', rel: 'a.kt', rev: null }], active: 1 }))
      expect(screen.getByTestId(`tab-${id}`)).toBe(host)
      expect(host.style.display).toBe('none')
      // Изменения — во всю ширину: панели терминала смонтированы, но места не занимают.
      expect(screen.getByTestId('panes')).toHaveClass('panes', 'off')
      expect(appear.finish).not.toHaveBeenCalled()
      act(() => useProject.getState().closeTab(1))
      expect(host.style.display).toBe('block')
      expect(screen.getByTestId('panes')).not.toHaveClass('off')
      expect(appear.finish).toHaveBeenCalledTimes(1)
    } finally {
      delete doc.getAnimations
    }
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
  it('корень проекта — из cwd панели в фокусе: смена вкладки и cd меняют root', () => {
    const setRoot = vi.fn()
    const prev = useProject.getState().setRoot
    useProject.setState({ setRoot })
    try {
      useTabs.getState().newTab('/a')
      const first = useTabs.getState().active
      useTabs.getState().newTab('/b/sub')
      render(<App />)
      expect(setRoot).toHaveBeenLastCalledWith('/b/sub')
      act(() => useTabs.getState().activate(first))
      expect(setRoot).toHaveBeenLastCalledWith('/a')
      const s = useTabs.getState()
      act(() => s.setCwd(s.tabs.find((t) => t.id === first)!.focused, '/c'))
      expect(setRoot).toHaveBeenLastCalledWith('/c')
      expect(setRoot).toHaveBeenCalledTimes(3)
    } finally {
      useProject.setState({ setRoot: prev })
    }
  })
})
