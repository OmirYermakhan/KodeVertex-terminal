import { beforeEach, describe, expect, it } from 'vitest'
import { leaves } from './paneTree'
import { initialTabsState, useTabs } from './tabsStore'

const active = () => {
  const s = useTabs.getState()
  return s.tabs.find((t) => t.id === s.active)!
}

describe('tabsStore', () => {
  beforeEach(() => useTabs.setState(initialTabsState()))

  it('starts with one tab and one pane', () => {
    expect(useTabs.getState().tabs).toHaveLength(1)
    expect(leaves(active().tree)).toHaveLength(1)
  })

  it('split focuses the new pane and copies cwd', () => {
    const first = active().focused
    useTabs.getState().setCwd(first, '/tmp/x')
    useTabs.getState().split('row')
    const t = active()
    expect(leaves(t.tree)).toHaveLength(2)
    expect(t.focused).not.toBe(first)
    expect(t.cwd[t.focused]).toBe('/tmp/x')
  })

  it('closeFocused moves focus to the neighbour', () => {
    const first = active().focused
    useTabs.getState().split('row')
    useTabs.getState().closeFocused()
    expect(leaves(active().tree)).toEqual([first])
    expect(active().focused).toBe(first)
  })

  it('closing_last_pane_closes_tab', () => {
    useTabs.getState().newTab()
    const [t1, t2] = useTabs.getState().tabs
    expect(useTabs.getState().active).toBe(t2.id)
    useTabs.getState().paneExited(t2.focused)
    const s = useTabs.getState()
    expect(s.tabs.map((t) => t.id)).toEqual([t1.id])
    expect(s.active).toBe(t1.id)
  })

  it('closing the last tab creates a fresh one', () => {
    const old = useTabs.getState().tabs[0]
    useTabs.getState().closeTab(old.id)
    const s = useTabs.getState()
    expect(s.tabs).toHaveLength(1)
    expect(s.tabs[0].id).not.toBe(old.id)
    expect(s.active).toBe(s.tabs[0].id)
  })

  it('activateIndex out of range is a no-op', () => {
    useTabs.getState().newTab()
    useTabs.getState().newTab()
    const before = useTabs.getState().active
    useTabs.getState().activateIndex(8)
    expect(useTabs.getState().active).toBe(before)
  })

  it('focusDir moves focus to the neighbour pane', () => {
    const first = active().focused
    useTabs.getState().split('row')
    useTabs.getState().focusDir('left')
    expect(active().focused).toBe(first)
  })

  it('newTab inherits the given cwd', () => {
    useTabs.getState().newTab('/work')
    expect(active().cwd[active().focused]).toBe('/work')
  })
})
