import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useTabs } from '../layout/tabsStore'
import { useUi } from '../ui/uiStore'
import Toasts from './Toasts'
import { useToasts } from './notify'

describe('Toasts', () => {
  beforeEach(() => useToasts.setState({ toasts: [] }))
  it('показывает тост, клик переходит к панели и агенту', () => {
    const pane = useTabs.getState().tabs[0].focused
    render(<Toasts />)
    useToasts.getState().push({ kind: 'waiting', text: '! Главный ждёт ответа', paneId: pane, agentId: 'main' })
    // push вне act: дожидаемся рендера через findBy не нужно — zustand синхронен, но React асинхронен
    return screen.findByText('! Главный ждёт ответа').then((el) => {
      fireEvent.click(el)
      expect(useUi.getState().agentRequest?.agentId).toBe('main')
      expect(screen.queryByText('! Главный ждёт ответа')).toBeNull()
    })
  })
})
