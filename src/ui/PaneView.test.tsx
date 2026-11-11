import { act, render } from '@testing-library/react'
import { useEffect } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { initialTabsState, useTabs } from '../layout/tabsStore'
import PaneView from './PaneView'

const mounts: Record<string, number> = {}
const unmounts: Record<string, number> = {}

vi.mock('../terminal/TerminalPane', () => ({
  TerminalPane: ({ paneId }: { paneId: string }) => {
    useEffect(() => {
      mounts[paneId] = (mounts[paneId] ?? 0) + 1
      return () => {
        unmounts[paneId] = (unmounts[paneId] ?? 0) + 1
      }
    }, [paneId])
    return null
  },
}))

function Harness() {
  const tabs = useTabs((s) => s.tabs)
  const active = useTabs((s) => s.active)
  return (
    <>
      {tabs.map((t) => (
        <PaneView key={t.id} tab={t} visible={t.id === active} />
      ))}
    </>
  )
}

describe('PaneView mounting', () => {
  beforeEach(() => {
    for (const k of Object.keys(mounts)) delete mounts[k]
    for (const k of Object.keys(unmounts)) delete unmounts[k]
    useTabs.setState(initialTabsState())
  })

  it('does not remount a pane on split or when a sibling closes', () => {
    render(<Harness />)
    const first = useTabs.getState().tabs[0].focused
    act(() => useTabs.getState().split('row'))
    expect(mounts[first]).toBe(1)
    expect(unmounts[first]).toBeUndefined()
    const second = useTabs.getState().tabs[0].focused
    expect(mounts[second]).toBe(1)

    act(() => useTabs.getState().closeFocused())
    expect(mounts[first]).toBe(1)
    expect(unmounts[first]).toBeUndefined()
    expect(unmounts[second]).toBe(1)
  })

  it('does not remount panes when switching tabs', () => {
    render(<Harness />)
    const first = useTabs.getState().tabs[0].focused
    act(() => useTabs.getState().newTab())
    const second = useTabs.getState().tabs[1].focused
    act(() => useTabs.getState().activate(useTabs.getState().tabs[0].id))
    act(() => useTabs.getState().activate(useTabs.getState().tabs[1].id))
    expect(mounts[first]).toBe(1)
    expect(mounts[second]).toBe(1)
    expect(unmounts[first]).toBeUndefined()
    expect(unmounts[second]).toBeUndefined()
  })
})
