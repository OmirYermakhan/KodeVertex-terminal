import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn(() => Promise.resolve()) }))

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(async (_id: string, _src: string) => ({ svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>', diagramType: 'flowchart' })),
}))
vi.mock('mermaid', () => ({ default: mermaid }))

URL.createObjectURL = vi.fn(() => 'blob:test/1')
URL.revokeObjectURL = vi.fn()

const { DiffView, TRUNCATED } = await import('./DiffView')
const { boundDiff } = await import('../diff')
const { resetDiagramCache } = await import('../diagram/render')
const { useSettings } = await import('../../settings/store')

const after = '# Заголовок\n\n```mermaid\ngraph TD; A-->B\n```\n'
const mk = (path: string) => ({ path, before: '', after, created: true })

beforeEach(() => {
  resetDiagramCache()
  useSettings.setState((s) => ({ settings: { ...s.settings, theme: 'kv', claudeDiagrams: true } }))
})

describe('DiffView: «Как документ» для .md', () => {
  it('переключает между строками и документом со схемой', async () => {
    const { container } = render(<DiffView diff={mk('/p/README.md')} />)
    expect(container.querySelector('.dl')).toBeTruthy()
    fireEvent.click(screen.getByText('Как документ'))
    expect(await screen.findByAltText('Схема')).toBeTruthy()
    expect(container.querySelector('.dl')).toBeNull()
    fireEvent.click(screen.getByText('Как изменения'))
    expect(container.querySelector('.dl')).toBeTruthy()
    expect(screen.queryByAltText('Схема')).toBeNull()
  })

  it('для не-markdown кнопки нет', () => {
    render(<DiffView diff={mk('/p/a.ts')} />)
    expect(screen.queryByText('Как документ')).toBeNull()
  })

  it('кнопка отмечает нажатое состояние (aria-pressed)', () => {
    render(<DiffView diff={mk('/p/README.md')} />)
    const b = screen.getByText('Как документ')
    expect(b.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(b)
    expect(screen.getByText('Как изменения').getAttribute('aria-pressed')).toBe('true')
  })

  it('Write .md (весь файл) — кнопка есть', () => {
    render(<DiffView diff={{ path: '/p/README.md', before: '', after }} />)
    expect(screen.getByText('Как документ')).toBeTruthy()
  })

  it('Edit .md до результата (только фрагмент new_string) — кнопки нет', () => {
    render(<DiffView diff={{ path: '/p/README.md', before: 'старое', after: '```mermaid\ngraph TD' }} />)
    expect(screen.queryByText('Как документ')).toBeNull()
  })

  it('восстановленная из сессии правка .md (boundDiff: куски, after пуст) — кнопки нет', () => {
    const edit = { path: '/p/README.md', before: 'a', after: 'b', hunks: [{ oldStart: 1, newStart: 1, lines: ['-a', '+b'] }], original: 'a\nc\n' }
    render(<DiffView diff={boundDiff(edit)} />)
    expect(screen.queryByText('Как документ')).toBeNull()
  })

  it('правка .md с исходным файлом и кусками — документ собирается целиком', () => {
    const edit = { path: '/p/README.md', before: 'a', after: 'b', hunks: [{ oldStart: 1, newStart: 1, lines: ['-a', '+# Новый'] }], original: 'a\nконец\n' }
    const { container } = render(<DiffView diff={edit} />)
    fireEvent.click(screen.getByText('Как документ'))
    const doc = container.querySelector('.dv-doc')!
    expect(doc.querySelector('h1')?.textContent).toBe('Новый')
    expect(doc.textContent).toContain('конец')
  })

  it('урезанный при сохранении Write — под документом пометка TRUNCATED', () => {
    const big = { path: '/p/README.md', before: '', after: Array.from({ length: 200 }, (_, i) => `строка ${i}`).join('\n'), created: true }
    const { container } = render(<DiffView diff={boundDiff(big)} />)
    fireEvent.click(screen.getByText('Как документ'))
    expect(container.querySelector('.dv-doc')!.textContent).toContain(TRUNCATED)
  })
})
