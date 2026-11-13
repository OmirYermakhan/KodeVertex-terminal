import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { ErrorBoundary } from './ErrorBoundary'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve()) }))
import { invoke } from '@tauri-apps/api/core'

let boom = true
function Bomb() {
  if (boom) throw new Error('сломалось')
  return <p>работает</p>
}

beforeEach(() => {
  boom = true
  vi.mocked(invoke).mockClear()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('ErrorBoundary', () => {
  it('inline: заглушка вместо упавшего куска, соседи живы, ошибка в журнале', () => {
    render(
      <div>
        <ErrorBoundary name="карточку">
          <Bomb />
        </ErrorBoundary>
        <p>сосед</p>
      </div>,
    )
    expect(screen.getByRole('alert').textContent).toContain('Не удалось показать карточку: Error: сломалось')
    expect(screen.getByText('сосед')).toBeTruthy()
    const call = vi.mocked(invoke).mock.calls.find((c) => c[0] === 'frontend_log')
    expect(call).toBeTruthy()
    expect(String((call![1] as { message: string }).message)).toContain('[карточку] Error: сломалось')
  })

  it('«Повторить» отрисовывает снова', () => {
    render(
      <ErrorBoundary name="карточку">
        <Bomb />
      </ErrorBoundary>,
    )
    boom = false
    fireEvent.click(screen.getByText('Повторить'))
    expect(screen.getByText('работает')).toBeTruthy()
  })

  it('смена resetKey сбрасывает ошибку', () => {
    const { rerender } = render(
      <ErrorBoundary name="карточку" resetKey={1}>
        <Bomb />
      </ErrorBoundary>,
    )
    boom = false
    rerender(
      <ErrorBoundary name="карточку" resetKey={2}>
        <Bomb />
      </ErrorBoundary>,
    )
    expect(screen.getByText('работает')).toBeTruthy()
  })

  it('window: текст ошибки и перезагрузка', () => {
    render(
      <ErrorBoundary name="окно" variant="window">
        <Bomb />
      </ErrorBoundary>,
    )
    expect(screen.getByText('Перезагрузить окно')).toBeTruthy()
    expect(document.querySelector('.crash-text')!.textContent).toContain('сломалось')
  })
})
