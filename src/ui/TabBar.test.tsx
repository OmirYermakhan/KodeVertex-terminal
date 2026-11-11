import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { initialTabsState, useTabs } from '../layout/tabsStore'
import TabBar from './TabBar'

describe('TabBar', () => {
  beforeEach(() => useTabs.setState(initialTabsState()))

  it('titles a tab by the last cwd segment', () => {
    const t = useTabs.getState().tabs[0]
    useTabs.getState().setCwd(t.focused, '/Users/me/projects/demo')
    render(<TabBar />)
    expect(screen.getByText('demo')).toBeInTheDocument()
  })

  it('+ adds a tab, click selects, middle click closes', () => {
    render(<TabBar />)
    fireEvent.click(screen.getByLabelText('Новая вкладка'))
    expect(useTabs.getState().tabs).toHaveLength(2)
    const [first] = screen.getAllByRole('tab')
    fireEvent.click(first)
    expect(useTabs.getState().active).toBe(useTabs.getState().tabs[0].id)
    fireEvent(first, new MouseEvent('auxclick', { bubbles: true, button: 1 }))
    expect(useTabs.getState().tabs).toHaveLength(1)
  })
})
