import { fireEvent, render, screen } from '@testing-library/react'
import { act } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import Viewer from './Viewer'
import { useProject } from './store'

describe('Viewer', () => {
  beforeEach(() => useProject.setState({ tabs: [], active: 0 }))

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
      'PaymentApi.kt✕',
      'PaymentService.kt · изменения✕',
      'PayScreen.kt · a41c9e2✕',
    ])
    expect(tabs[1]).toHaveClass('et', 'on')
    fireEvent.click(tabs[0])
    expect(useProject.getState().active).toBe(0)
    fireEvent.click(screen.getAllByRole('button', { name: 'Закрыть вкладку' })[2])
    expect(useProject.getState().tabs).toHaveLength(2)
  })
})
