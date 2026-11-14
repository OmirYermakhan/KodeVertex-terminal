import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import Stripe from './Stripe'
import { useProject } from './store'

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
})
