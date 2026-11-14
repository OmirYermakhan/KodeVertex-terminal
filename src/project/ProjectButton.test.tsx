import { fireEvent, render, screen } from '@testing-library/react'
import { act } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import ProjectButton, { projectInitials } from './ProjectButton'
import { useProject } from './store'

describe('ProjectButton', () => {
  beforeEach(() => useProject.setState({ tool: null }))

  it('показывает имя и ветку из git, как строка состояния', () => {
    render(<ProjectButton cwd="/Users/me/work/shop-app/app" git={{ root: '/Users/me/work/shop-app', branch: 'feature/payments', dirty: false }} />)
    const b = screen.getByRole('button', { name: /shop-app/ })
    expect(b).toHaveTextContent('SA')
    expect(b).toHaveTextContent('shop-app')
    expect(b).toHaveTextContent('feature/payments')
    expect(b).toHaveTextContent('▾')
  })

  it('без git — имя папки и без ветки', () => {
    render(<ProjectButton cwd="/tmp/notes" git={null} />)
    const b = screen.getByRole('button', { name: /notes/ })
    expect(b.querySelector('.br')).toBeNull()
  })

  it('клик открывает «Проект», повторный — скрывает; открытое окно подсвечивает кнопку', () => {
    render(<ProjectButton cwd="/tmp/notes" git={null} />)
    const b = screen.getByRole('button', { name: /notes/ })
    fireEvent.click(b)
    expect(useProject.getState().tool).toBe('project')
    expect(b).toHaveClass('on')
    fireEvent.click(b)
    expect(useProject.getState().tool).toBeNull()
    expect(b).not.toHaveClass('on')
    act(() => useProject.setState({ tool: 'git' }))
    expect(b).not.toHaveClass('on')
  })

  it('две буквы значка', () => {
    expect(projectInitials('shop-app')).toBe('SA')
    expect(projectInitials('kodevertex_terminal')).toBe('KT')
    expect(projectInitials('notes')).toBe('NO')
    expect(projectInitials('~')).toBe('~')
    expect(projectInitials('проект')).toBe('ПР')
  })
})
