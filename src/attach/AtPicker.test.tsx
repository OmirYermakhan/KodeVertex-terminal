import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve(null)) }))

const { AtPicker } = await import('./AtPicker')
type AtRow = import('./atSearch').AtRow

const msg = (text: string): AtRow => ({ group: 'messages', key: 'm:1', id: 'cl-1', text, snippet: text, mark: null })

describe('AtPicker', () => {
  it('просмотр ещё идущего ответа обновляется вместе с текстом (тот же ключ строки)', () => {
    const props = { selected: 0, query: '', dirPart: '', dir: '/w', onPick: () => {}, onSelect: () => {} }
    const { container, rerender } = render(<AtPicker {...props} rows={[msg('Первая часть')]} />)
    expect(container.querySelector('.pop-side')?.textContent).toContain('Первая часть')
    rerender(<AtPicker {...props} rows={[msg('Первая часть и продолжение')]} />)
    expect(container.querySelector('.pop-side')?.textContent).toContain('и продолжение')
  })
})
