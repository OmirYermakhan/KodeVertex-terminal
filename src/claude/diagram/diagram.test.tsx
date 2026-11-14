import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn(() => Promise.resolve()) }))

// mermaid в jsdom не работает (нужны настоящие размеры текста) — подменяем.
const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(async (_id: string, _src: string) => ({ svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>', diagramType: 'flowchart' })),
}))
vi.mock('mermaid', () => ({ default: mermaid }))

let blobs = 0
URL.createObjectURL = vi.fn(() => `blob:test/${++blobs}`)
URL.revokeObjectURL = vi.fn()

const { Markdown } = await import('../Markdown')
const { renderDiagram, resetDiagramCache } = await import('./render')
const { useSettings } = await import('../../settings/store')

const fence = (src: string) => '```mermaid\n' + src + '\n```'

beforeEach(() => {
  mermaid.initialize.mockClear()
  mermaid.render.mockClear()
  resetDiagramCache()
  useSettings.setState((s) => ({ settings: { ...s.settings, theme: 'kv', claudeDiagrams: true } }))
})

describe('схемы mermaid', () => {
  it('рисует картинку вместо кода', async () => {
    const { container } = render(<Markdown text={fence('graph TD; A-->B')} />)
    const img = await screen.findByAltText('Схема')
    expect(img.getAttribute('src')).toMatch(/^blob:/)
    expect(container.querySelector('svg')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
    expect(mermaid.initialize).toHaveBeenCalledWith(expect.objectContaining({ securityLevel: 'strict', htmlLabels: false, startOnLoad: false }))
  })

  it('пока печатается — код и «Схема рисуется…», mermaid не вызван', async () => {
    const { container } = render(<Markdown text={fence('graph TD; A-->B')} streaming />)
    expect(screen.getByText('Схема рисуется…')).toBeTruthy()
    expect(container.querySelector('pre')?.textContent).toContain('A-->B')
    await act(async () => {})
    expect(mermaid.render).not.toHaveBeenCalled()
    expect(container.querySelector('img')).toBeNull()
  })

  it('ошибка синтаксиса — исходник и «Схему не удалось нарисовать»', async () => {
    mermaid.render.mockRejectedValueOnce(new Error('Parse error'))
    const { container } = render(<Markdown text={fence('graph TD; A-->')} />)
    await screen.findByText('Схему не удалось нарисовать')
    expect(container.querySelector('pre')?.textContent).toContain('A-->')
    expect(container.querySelector('img')).toBeNull()
  })

  it('кэш по теме', async () => {
    const a = await renderDiagram('graph TD; A-->B', 'kv')
    const b = await renderDiagram('graph TD; A-->B', 'kv')
    expect(a).toEqual(b)
    expect(mermaid.render).toHaveBeenCalledTimes(1)
    const c = await renderDiagram('graph TD; A-->B', 'light')
    expect(c.ok && a.ok && c.url !== a.url).toBe(true)
    expect(mermaid.render).toHaveBeenCalledTimes(2)
    expect(mermaid.initialize).toHaveBeenCalledTimes(2)
    expect(mermaid.initialize).toHaveBeenLastCalledWith(expect.objectContaining({ themeVariables: expect.objectContaining({ background: '#f6f5f0' }) }))
  })

  it('выключено в настройках — обычный блок кода', async () => {
    const { container } = render(<Markdown text={fence('graph TD; A-->B')} diagrams={false} />)
    await act(async () => {})
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('.md-code pre')?.textContent).toContain('A-->B')
    expect(mermaid.render).not.toHaveBeenCalled()
  })

  it('по умолчанию берёт переключатель из настроек', async () => {
    useSettings.setState((s) => ({ settings: { ...s.settings, claudeDiagrams: false } }))
    const { container } = render(<Markdown text={fence('graph TD; A-->B')} />)
    await act(async () => {})
    expect(container.querySelector('img')).toBeNull()
    expect(mermaid.render).not.toHaveBeenCalled()
  })

  it('«Исходник» показывает код, «Копировать» пишет исходник в буфер', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const { container } = render(<Markdown text={fence('graph TD; A-->B')} />)
    await screen.findByAltText('Схема')
    expect(container.querySelector('pre')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Исходник' }))
    expect(container.querySelector('pre')?.textContent).toBe('graph TD; A-->B')
    fireEvent.click(screen.getByRole('button', { name: 'Исходник' }))
    expect(container.querySelector('pre')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Копировать' }))
    expect(writeText).toHaveBeenCalledWith('graph TD; A-->B')
    await waitFor(() => expect(screen.getByText('Скопировано')).toBeTruthy())
  })
})
