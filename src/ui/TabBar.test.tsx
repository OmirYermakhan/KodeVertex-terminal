import { fireEvent, render, screen } from '@testing-library/react'
import { act } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useClaudeSessions } from '../claude/sessionStore'
import { initialClaude, type ClaudeState } from '../claude/reducer'
import { mockupScene } from '../claude/fixtures/mockupScene'
import { initialTabsState, useTabs } from '../layout/tabsStore'
import TabBar from './TabBar'

describe('TabBar', () => {
  beforeEach(() => {
    useTabs.setState(initialTabsState())
    useClaudeSessions.setState({ sessions: {} })
  })

  const setSession = (paneId: string, state: ClaudeState) =>
    act(() =>
      useClaudeSessions.setState((s) => ({ sessions: { ...s.sessions, [paneId]: { state, procId: 'c', cwd: null, model: null, effort: null, permissionMode: null, queue: [], paused: false, pauseHint: false } } })),
    )
  const dots = () => screen.getAllByRole('tab').map((t) => t.querySelector('[data-testid="tab-dot"]')?.getAttribute('data-status') ?? null)
  const doneState = (endedAt: number): ClaudeState => {
    const s = initialClaude()
    return { ...s, agents: s.agents.map((a) => ({ ...a, status: 'done', startedAt: endedAt - 1000, endedAt })) }
  }

  it('точки: активная — --acc; работает — пульс, ждёт, ошибка; «готово» — пока вкладку не открыли', () => {
    act(() => useTabs.getState().newTab())
    const [a, b] = useTabs.getState().tabs
    render(<TabBar />)
    // Активна вторая вкладка; у первой без Claude точки нет.
    expect(dots()).toEqual([null, 'on'])

    setSession(a.focused, mockupScene()) // Главный ждёт ответа
    expect(dots()).toEqual(['waiting', 'on'])
    setSession(a.focused, { ...mockupScene(), agents: mockupScene().agents.filter((x) => x.status !== 'waiting') })
    expect(dots()).toEqual(['running', 'on'])
    expect(screen.getAllByRole('tab')[0].textContent).toContain('· claude')

    setSession(a.focused, doneState(Date.now()))
    expect(dots()).toEqual(['done', 'on'])
    // Открыли вкладку — «готово» увидено.
    act(() => useTabs.getState().activate(a.id))
    expect(dots()).toEqual(['on', null])
    act(() => useTabs.getState().activate(b.id))
    expect(dots()).toEqual([null, 'on'])

    const err = initialClaude()
    setSession(a.focused, { ...err, agents: err.agents.map((x) => ({ ...x, status: 'error', startedAt: 1, endedAt: 2 })) })
    expect(dots()).toEqual(['error', 'on'])
  })

  it('готово в активной вкладке — уже увидено', () => {
    const [a] = useTabs.getState().tabs
    render(<TabBar />)
    setSession(a.focused, doneState(Date.now()))
    act(() => useTabs.getState().newTab())
    expect(dots()).toEqual([null, 'on'])
  })

  it('titles a tab by the last cwd segment', () => {
    const t = useTabs.getState().tabs[0]
    useTabs.getState().setCwd(t.focused, '/Users/me/projects/demo')
    render(<TabBar />)
    // Имя — и во вкладке, и в кнопке проекта слева (макет 07).
    expect(screen.getByRole('tab')).toHaveTextContent('demo')
    expect(screen.getByRole('button', { name: /demo/ })).toHaveClass('proj')
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
