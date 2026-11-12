import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { HintsPopup, hintKeys } from './HintsPopup'
import { BUILTIN_SLASH, CLAUDE_OPTIONS, hintContext, rankHints } from './claudeHints'
import type { HintsState } from './useHints'

function state(buffer: string, mode: 'shell' | 'claude' = 'shell', over: Partial<HintsState> = {}): HintsState {
  const ctx = hintContext(buffer, buffer.length, mode)!
  const rows = rankHints(ctx, mode === 'shell' ? CLAUDE_OPTIONS : BUILTIN_SLASH)
  return { open: true, ctx, rows, selected: -1, navigated: false, buffer, ...over }
}

describe('HintsPopup', () => {
  it('группы с заголовками, команда и описание', () => {
    const { container } = render(<HintsPopup state={state('claude')} onPick={vi.fn()} />)
    expect([...container.querySelectorAll('.hp-h')].map((h) => h.textContent)).toEqual([
      'Режим карточек',
      'Полный экран',
      'Служебные',
    ])
    const rows = screen.getAllByRole('option')
    expect(rows[0].textContent).toBe('◆claudeОткрыть режим Claude')
    expect(rows[2].querySelector('.hp-n')!.textContent).toBe('-c, --continue')
    expect(rows[2].querySelector('.hp-d')!.textContent).toBe('Продолжить последний разговор (полный экран)')
    expect(rows.some((r) => r.getAttribute('aria-selected') === 'true')).toBe(false)
  })

  it('подсветка совпадения и выбранная строка', () => {
    const { container } = render(
      <HintsPopup state={state('/mo', 'claude', { selected: 0, navigated: true })} onPick={vi.fn()} />,
    )
    expect(container.querySelector('.hp-h')!.textContent).toBe('Встроенные')
    const row = screen.getAllByRole('option')[0]
    expect(row).toHaveClass('sel')
    expect(row.querySelector('.hp-n')!.textContent).toBe('/model')
    expect([...row.querySelectorAll('b')].map((b) => b.textContent)).toEqual(['mo'])
  })

  it('подсказка клавиш совпадает с поведением', () => {
    expect(hintKeys(state('claude'))).toBe('↑↓ выбрать · ↵ выполнить · esc закрыть')
    expect(hintKeys(state('claude', 'shell', { selected: 1, navigated: true }))).toBe(
      '↑↓ выбрать · ⇥ подставить · ↵ выполнить · esc закрыть',
    )
    // «Открыть режим» — подставлять нечего.
    expect(hintKeys(state('claude', 'shell', { selected: 0, navigated: true }))).toBe(
      '↑↓ выбрать · ↵ выполнить · esc закрыть',
    )
    expect(hintKeys(state('/c', 'claude', { selected: 0 }))).toBe('↑↓ выбрать · ⇥ подставить · ↵ отправить · esc закрыть')
  })

  it('клик — onPick', () => {
    const onPick = vi.fn()
    render(<HintsPopup state={state('claude ')} onPick={onPick} />)
    fireEvent.mouseDown(screen.getAllByRole('option')[1])
    expect(onPick).toHaveBeenCalledWith(1)
  })
})
