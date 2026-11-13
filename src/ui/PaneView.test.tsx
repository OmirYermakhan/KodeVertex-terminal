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

  it('полоса фокуса только при нескольких панелях', () => {
    const { getByTestId } = render(<Harness />)
    const first = useTabs.getState().tabs[0].focused
    expect(getByTestId(`pane-${first}`).style.borderTop).toBe('')
    act(() => useTabs.getState().split('row'))
    const second = useTabs.getState().tabs[0].focused
    expect(getByTestId(`pane-${second}`).style.borderTop).toBe('2px solid var(--acc)')
    expect(getByTestId(`pane-${first}`).style.borderTop).toBe('2px solid transparent')
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

  it('вкладку снова показали — разовые анимации появления в ней доводятся до конца, остальные не трогаются', () => {
    const { getByTestId } = render(<Harness />)
    const t0 = useTabs.getState().tabs[0].id
    act(() => useTabs.getState().newTab())
    const t1 = useTabs.getState().tabs[1].id
    // Web Animations в jsdom нет: document.getAnimations отдаёт подставные анимации.
    const inTab0 = document.createElement('div')
    getByTestId(`tab-${t0}`).appendChild(inTab0)
    const inTab1 = document.createElement('div')
    getByTestId(`tab-${t1}`).appendChild(inTab1)
    const anim = (name: string, target: Element) => ({ animationName: name, effect: { target }, finish: vi.fn() })
    const appear = anim('kv-in', inTab0)
    const caret = anim('kv-pulse', inTab0)
    const other = anim('kv-in', inTab1)
    const doc = document as unknown as { getAnimations?: () => unknown[] }
    doc.getAnimations = () => [appear, caret, other]
    try {
      // Скрыли вкладку — ничего не доводим.
      expect(appear.finish).not.toHaveBeenCalled()
      act(() => useTabs.getState().activate(t0))
      expect(appear.finish).toHaveBeenCalledTimes(1)
      expect(caret.finish).not.toHaveBeenCalled()
      expect(other.finish).not.toHaveBeenCalled()
      act(() => useTabs.getState().activate(t1))
      expect(other.finish).toHaveBeenCalledTimes(1)
      expect(appear.finish).toHaveBeenCalledTimes(1)
    } finally {
      delete doc.getAnimations
    }
  })
})
