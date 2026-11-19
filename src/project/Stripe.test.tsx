import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import Stripe from './Stripe'
import { useProject } from './store'
import { act } from 'react'
import { initialTabsState, useTabs } from '../layout/tabsStore'
import { useSettings } from '../settings/store'
import { normalizeSettings } from '../settings/settings'
import { resetRunnersForTest } from '../launch/runner'

describe('Stripe', () => {
  beforeEach(() => useProject.setState({ tool: null }))

  it('три значка с подсказками клавиш; активный — on; повторный клик скрывает', () => {
    render(<Stripe />)
    const project = screen.getByRole('button', { name: 'Проект' })
    const changes = screen.getByRole('button', { name: 'Изменения' })
    const git = screen.getByRole('button', { name: 'Git' })
    expect(project).toHaveAttribute('title', 'Проект ⌥⌘1')
    expect(changes).toHaveAttribute('title', 'Изменения ⌥⌘0')
    expect(git).toHaveAttribute('title', 'Git ⌥⌘9')
    fireEvent.click(changes)
    expect(useProject.getState().tool).toBe('changes')
    expect(changes).toHaveClass('sb', 'on')
    expect(project).not.toHaveClass('on')
    fireEvent.click(git)
    expect(useProject.getState().tool).toBe('git')
    fireEvent.click(git)
    expect(useProject.getState().tool).toBeNull()
    expect(git).not.toHaveClass('on')
  })

  it('вход без вкладки приглушён; открытый — полоска; активный — on', () => {
    resetRunnersForTest()
    useTabs.setState(initialTabsState())
    useSettings.setState({
      settings: {
        ...normalizeSettings(undefined),
        launchers: [
          { id: 'a', name: 'A', command: '', cwd: '/a', icon: 'server', color: '#4f8cff' },
          { id: 'b', name: 'B', command: '', cwd: '/b', icon: 'server', color: '#4f8cff' },
        ],
      },
    })
    render(<Stripe />)
    const a = screen.getByRole('button', { name: 'A' })
    const b = screen.getByRole('button', { name: 'B' })
    expect(a).not.toHaveClass('open')
    expect(screen.queryAllByTestId('launcher-open')).toHaveLength(0)
    fireEvent.click(a)
    expect(a).toHaveClass('open', 'on')
    fireEvent.click(b)
    expect(a).toHaveClass('open')
    expect(a).not.toHaveClass('on')
    expect(b).toHaveClass('open', 'on')
    expect(screen.getAllByTestId('launcher-open')).toHaveLength(2)
    act(() => useTabs.getState().closeTab(useTabs.getState().tabs.find((t) => t.launcher === 'a')!.id))
    expect(a).not.toHaveClass('open')
  })
})
