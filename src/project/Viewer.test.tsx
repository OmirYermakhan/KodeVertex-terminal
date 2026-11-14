import { fireEvent, render, screen } from '@testing-library/react'
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./api', () => ({
  projectRead: async () => ({ kind: 'text', lines: ['fun main() {}'], truncated: false, size: 13 }),
  gitDiff: async () => '',
}))
vi.mock('../attach/preview/api', () => ({ openPath: async () => {} }))

const { default: Viewer } = await import('./Viewer')
const { useProject } = await import('./store')

describe('Viewer', () => {
  beforeEach(() => useProject.setState({ tabs: [], active: 0, root: '/r', changes: [], notGit: false, cursors: {} }))

  it('без вкладок — ничего', () => {
    const { container } = render(<Viewer />)
    expect(container.firstChild).toBeNull()
  })

  it('вкладки: имя файла, активная — on, ✕ закрывает, клик — переключает', () => {
    act(() =>
      useProject.setState({
        tabs: [
          { kind: 'file', rel: 'app/PaymentApi.kt' },
          { kind: 'diff', rel: 'app/PaymentService.kt', rev: null },
          { kind: 'diff', rel: 'ui/PayScreen.kt', rev: 'a41c9e2' },
        ],
        active: 1,
      }),
    )
    render(<Viewer />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((t) => t.textContent)).toEqual([
      'KPaymentApi.kt✕',
      'KPaymentService.kt · изменения✕',
      'KPayScreen.kt · a41c9e2✕',
    ])
    expect(tabs[1]).toHaveClass('et', 'on')
    fireEvent.click(tabs[0])
    expect(useProject.getState().active).toBe(0)
    fireEvent.click(screen.getAllByRole('button', { name: 'Закрыть вкладку' })[2])
    expect(useProject.getState().tabs).toHaveLength(2)
  })

  it('вкладка файла: значок, имя цветом git-статуса; содержимое — просмотр файла', async () => {
    act(() =>
      useProject.setState({
        changes: [
          { path: 'app/PaymentApi.kt', status: 'M' },
          { path: 'app/PaymentService.kt', status: 'A' },
          { path: 'app/New.kt', status: '?' },
        ],
        tabs: [
          { kind: 'file', rel: 'app/PaymentApi.kt' },
          { kind: 'file', rel: 'app/PaymentService.kt' },
          { kind: 'file', rel: 'app/New.kt' },
          { kind: 'file', rel: 'README.md' },
        ],
        active: 1,
      }),
    )
    render(<Viewer />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs[0].querySelector('.fi.pfi.kt')?.textContent).toBe('K')
    expect(tabs[3].querySelector('.fi.pfi.md')).not.toBeNull()
    expect(tabs.map((t) => t.className)).toEqual(['et mod', 'et on add', 'et new', 'et'])
    expect(await screen.findByText('fun')).toBeInTheDocument()
    expect(document.querySelector('.ed-body .code')).not.toBeNull()
  })

  it('вкладка изменений — просмотр изменений файла', async () => {
    act(() => useProject.setState({ tabs: [{ kind: 'diff', rel: 'a.kt', rev: null }], active: 0 }))
    render(<Viewer />)
    expect(document.querySelector('.ed.full .dvh .ro')?.textContent).toBe('HEAD → рабочая копия')
    expect(await screen.findByText('Изменений нет')).toBeInTheDocument()
  })

  it('открылась вкладка изменений — фокус в просмотре', () => {
    act(() => useProject.setState({ tabs: [{ kind: 'file', rel: 'a.kt' }], active: 0 }))
    render(<Viewer />)
    expect(document.activeElement?.closest('[data-viewer]')).toBeNull()
    act(() => useProject.getState().openDiff('a.kt', null))
    expect(document.activeElement).toBe(screen.getByTestId('viewer'))
  })
})
