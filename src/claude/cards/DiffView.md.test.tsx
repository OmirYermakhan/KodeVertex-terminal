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

const { DiffView } = await import('./DiffView')
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
})
