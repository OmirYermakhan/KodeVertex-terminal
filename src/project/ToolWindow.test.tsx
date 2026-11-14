import { fireEvent, render, screen } from '@testing-library/react'
import { act } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import ToolWindow from './ToolWindow'
import { useProject } from './store'

const git = { root: '/w/shop-app', branch: 'feature/payments', dirty: false }

describe('ToolWindow', () => {
  beforeEach(() => useProject.setState({ tool: null, width: 290 }))

  it('закрыто — ничего не рисует', () => {
    const { container } = render(<ToolWindow git={git} />)
    expect(container.firstChild).toBeNull()
  })

  it('по инструменту — заголовок и свой вид', () => {
    act(() => useProject.setState({ tool: 'project' }))
    render(<ToolWindow git={git} />)
    const tw = screen.getByTestId('toolwindow')
    expect(tw.style.width).toBe('290px')
    expect(tw.querySelector('.twh')).toHaveTextContent('Проект')
    expect(screen.getByTestId('project-tree')).toBeInTheDocument()
    act(() => useProject.setState({ tool: 'changes' }))
    expect(tw.querySelector('.twh')).toHaveTextContent('Изменения')
    expect(tw.querySelector('.twh .sub')).toHaveTextContent('feature/payments')
    expect(screen.getByTestId('changes-view')).toBeInTheDocument()
    act(() => useProject.setState({ tool: 'git' }))
    expect(tw.querySelector('.twh .sub')).toHaveTextContent('лог · feature/payments')
    expect(screen.getByTestId('git-log')).toBeInTheDocument()
  })

  it('esc внутри окна — скрывает; «—» — скрывает', () => {
    act(() => useProject.setState({ tool: 'project' }))
    render(<ToolWindow git={git} />)
    fireEvent.keyDown(screen.getByTestId('project-tree'), { key: 'Escape', code: 'Escape' })
    expect(useProject.getState().tool).toBeNull()
    act(() => useProject.setState({ tool: 'git' }))
    fireEvent.click(screen.getByRole('button', { name: 'Скрыть' }))
    expect(useProject.getState().tool).toBeNull()
  })

  it('открылось — фокус в окне (esc работает сразу); закрылось — фокус вернулся, откуда пришёл', () => {
    const input = document.createElement('textarea')
    document.body.appendChild(input)
    input.focus()
    render(<ToolWindow git={git} />)
    act(() => useProject.getState().toggle('project'))
    const tw = screen.getByTestId('toolwindow')
    expect(document.activeElement).toBe(tw)
    act(() => useProject.getState().toggle('git'))
    expect(document.activeElement).toBe(tw)
    fireEvent.keyDown(document.activeElement!, { key: 'Escape', code: 'Escape' })
    expect(useProject.getState().tool).toBeNull()
    expect(document.activeElement).toBe(input)
    act(() => useProject.getState().toggle('changes'))
    act(() => useProject.getState().toggle('changes'))
    expect(document.activeElement).toBe(input)
    input.remove()
  })

  it('край окна тянется — ширина меняется (в пределах 200–600)', () => {
    act(() => useProject.setState({ tool: 'project', width: 290 }))
    render(<ToolWindow git={git} />)
    const edge = screen.getByTestId('tw-resize')
    fireEvent.mouseDown(edge, { button: 0, clientX: 330 })
    fireEvent.mouseMove(window, { clientX: 380 })
    expect(useProject.getState().width).toBe(340)
    expect(screen.getByTestId('toolwindow').style.width).toBe('340px')
    fireEvent.mouseMove(window, { clientX: 2000 })
    expect(useProject.getState().width).toBe(600)
    fireEvent.mouseUp(window)
    fireEvent.mouseMove(window, { clientX: 100 })
    expect(useProject.getState().width).toBe(600)
  })
})
