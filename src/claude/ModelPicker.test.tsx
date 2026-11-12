import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ModelPicker, PICKER_KEYS } from './ModelPicker'
import { initialPicker } from './models'

describe('ModelPicker', () => {
  it('заголовок, описание, строки с номерами; ✓ у текущей; Fable — золотом', () => {
    const { container } = render(<ModelPicker state={initialPicker('opus', 'medium')} current="fable" onSelect={vi.fn()} />)
    expect(container.querySelector('.hp-h')!.textContent).toBe('Выбор модели')
    expect(container.querySelector('.mp-desc')!.textContent).toBe('Модель для новых сессий; s — только для этой сессии')
    const rows = screen.getAllByRole('option')
    expect(rows.map((r) => r.querySelector('.hp-n')!.textContent)).toEqual([
      'Default (рекомендуется)',
      'Opus 5.5',
      'Fable 5.2',
      'Sonnet 5.5',
      'Haiku 5.5',
    ])
    expect(rows[0].querySelector('.hp-g')!.textContent).toBe('1.')
    expect(rows[0].querySelector('.hp-d')!.textContent).toBe('Opus 5.5 · для повседневных и сложных задач')
    expect(rows[1].getAttribute('aria-selected')).toBe('true')
    expect(rows[2].querySelector('.mp-ok')!.textContent).toBe('✓')
    expect(rows.filter((r) => r.querySelector('.mp-ok')!.textContent)).toHaveLength(1)
    expect(rows[2].classList.contains('fable')).toBe(true)
    expect(container.querySelector('.hp-keys')!.textContent).toBe(PICKER_KEYS)
    expect(PICKER_KEYS).toBe('↵ сделать по умолчанию · s только эта сессия · esc отмена')
  })

  it('строка усилия: «(по умолчанию)», пока не меняли', () => {
    const s = initialPicker(null, 'medium')
    const { container, rerender } = render(<ModelPicker state={s} current="default" onSelect={vi.fn()} />)
    expect(container.querySelector('.mp-effort')!.textContent).toBe('◐ Усилие: medium (по умолчанию) ←/→')
    rerender(<ModelPicker state={{ ...s, effort: 3, effortTouched: true }} current="default" onSelect={vi.fn()} />)
    expect(container.querySelector('.mp-effort')!.textContent).toBe('◐ Усилие: xhigh ←/→')
  })

  it('клик выбирает строку', () => {
    const onSelect = vi.fn()
    render(<ModelPicker state={initialPicker(null, null)} current="default" onSelect={onSelect} />)
    fireEvent.mouseDown(screen.getAllByRole('option')[3])
    expect(onSelect).toHaveBeenCalledWith(3)
  })
})
