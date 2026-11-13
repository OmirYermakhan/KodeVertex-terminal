import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { RESUME_EMPTY, RESUME_KEYS, RESUME_LOADING, ResumePicker } from './ResumePicker'
import { initialResume, type SessionInfo } from './resume'

const now = Date.UTC(2026, 10, 13, 12)
const rows: SessionInfo[] = [
  { id: 'a', title: 'Первый разговор', modified: now - 5 * 60_000, messages: 14, partial: false },
  { id: 'b', title: 'Второй', modified: now - 3 * 3600_000, messages: 2, partial: false },
]

describe('ResumePicker', () => {
  it('рамка выбора модели: заголовок, описание, строки с номерами, ✓ у текущего, клавиши', () => {
    const { container } = render(<ResumePicker state={{ ...initialResume(), rows, selected: 1 }} current="a" now={now} onSelect={vi.fn()} onPick={vi.fn()} />)
    expect(container.querySelector('.cp.hp.mp.rp')).not.toBeNull()
    expect(container.querySelector('.hp-h')!.textContent).toBe('Продолжить разговор')
    expect(container.querySelector('.mp-desc')!.textContent).toBe('Прошлые разговоры Claude Code в этом каталоге')
    const opts = screen.getAllByRole('option')
    expect(opts.map((o) => o.querySelector('.hp-g')!.textContent)).toEqual(['1.', '2.'])
    expect(opts[0].querySelector('.hp-n')!.textContent).toBe('Первый разговор')
    expect(opts[0].querySelector('.hp-d')!.textContent).toBe('5 мин назад · 14 сообщений')
    expect(opts[0].querySelector('.mp-ok')!.textContent).toBe('✓')
    expect(opts[1].querySelector('.mp-ok')!.textContent).toBe('')
    expect(opts[1].getAttribute('aria-selected')).toBe('true')
    expect(container.querySelector('.hp-keys')!.textContent).toBe(RESUME_KEYS)
  })

  it('загрузка, пусто, ошибка', () => {
    const { container, rerender } = render(<ResumePicker state={initialResume()} current={null} now={now} onSelect={vi.fn()} onPick={vi.fn()} />)
    expect(container.querySelector('.rp-empty')!.textContent).toBe(RESUME_LOADING)
    rerender(<ResumePicker state={{ ...initialResume(), rows: [] }} current={null} now={now} onSelect={vi.fn()} onPick={vi.fn()} />)
    expect(container.querySelector('.rp-empty')!.textContent).toBe(RESUME_EMPTY)
    rerender(<ResumePicker state={{ ...initialResume(), rows: [], error: 'нет доступа' }} current={null} now={now} onSelect={vi.fn()} onPick={vi.fn()} />)
    expect(container.querySelector('.rp-empty.err')!.textContent).toBe('нет доступа')
  })

  it('клик выбирает строку, клик по выбранной — продолжает', () => {
    const onSelect = vi.fn()
    const onPick = vi.fn()
    render(<ResumePicker state={{ ...initialResume(), rows }} current={null} now={now} onSelect={onSelect} onPick={onPick} />)
    fireEvent.mouseDown(screen.getAllByRole('option')[1])
    expect(onSelect).toHaveBeenCalledWith(1)
    fireEvent.mouseDown(screen.getAllByRole('option')[0])
    expect(onPick).toHaveBeenCalledWith(0)
  })
})
