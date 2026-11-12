import { createRef } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PAUSE_HINT, QUEUE_KEYS, QueuePanel, type QueuePanelHandle } from './QueuePanel'

const queue = [
  { id: 1, text: 'добавь тесты' },
  { id: 2, text: 'и обнови README' },
]

describe('QueuePanel', () => {
  it('заголовок «В очереди · N», клавиши; строки с меткой «ждёт» и ✕', () => {
    const { container } = render(<QueuePanel queue={queue} paused={false} onRemove={vi.fn()} onExit={vi.fn()} />)
    expect(container.querySelector('.dh')!.textContent).toBe(`В очереди · 2${QUEUE_KEYS}`)
    expect(Array.from(container.querySelectorAll('.qu-row')).map((r) => r.textContent)).toEqual([
      'добавь тестыждёт✕',
      'и обнови READMEждёт✕',
    ])
  })

  it('пауза — подсказка в заголовке', () => {
    const { container } = render(<QueuePanel queue={queue} paused onRemove={vi.fn()} onExit={vi.fn()} />)
    expect(container.querySelector('.qu-pause')!.textContent).toBe(` · ${PAUSE_HINT}`)
  })

  it('✕ убирает строку', () => {
    const onRemove = vi.fn()
    render(<QueuePanel queue={queue} paused={false} onRemove={onRemove} onExit={vi.fn()} />)
    fireEvent.mouseDown(screen.getAllByRole('button', { name: 'Убрать из очереди' })[1])
    expect(onRemove).toHaveBeenCalledWith(2)
  })

  it('фокус: первая строка; ↓ следующая; ⌫ убирает выбранную; esc — к вводу', () => {
    const ref = createRef<QueuePanelHandle>()
    const onRemove = vi.fn()
    const onExit = vi.fn()
    const { container } = render(<QueuePanel ref={ref} queue={queue} paused={false} onRemove={onRemove} onExit={onExit} />)
    act(() => ref.current!.focus())
    expect(ref.current!.hasFocus()).toBe(true)
    const box = container.querySelector('.queue') as HTMLElement
    expect(container.querySelector('.qu-row.focus')!.textContent).toContain('добавь тесты')
    fireEvent.keyDown(box, { key: 'ArrowDown' })
    expect(container.querySelector('.qu-row.focus')!.textContent).toContain('README')
    fireEvent.keyDown(box, { key: 'Backspace' })
    expect(onRemove).toHaveBeenCalledWith(2)
    fireEvent.keyDown(box, { key: 'Escape' })
    expect(onExit).toHaveBeenCalled()
  })

  it('последняя строка убрана — назад к вводу', () => {
    const ref = createRef<QueuePanelHandle>()
    const onExit = vi.fn()
    const { container } = render(<QueuePanel ref={ref} queue={[queue[0]]} paused={false} onRemove={vi.fn()} onExit={onExit} />)
    act(() => ref.current!.focus())
    fireEvent.keyDown(container.querySelector('.queue')!, { key: 'Delete' })
    expect(onExit).toHaveBeenCalled()
  })
})
