import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CompletionPopup, matchPositions } from './CompletionPopup'
import { completionContext } from './completion'
import type { CompletionState, FsPreviewTS } from './useCompletion'

const items = [
  { name: 'src', isDir: true, isSymlink: false },
  { name: 'README.md', isDir: false, isSymlink: false },
]

function state(over: Partial<CompletionState> = {}): CompletionState {
  return {
    open: true,
    items,
    selected: 1,
    ctx: completionContext('ls r', 4),
    preview: null,
    dir: '/p',
    navigated: false,
    buffer: 'ls r',
    lineStart: 0,
    lineEnd: 4,
    ...over,
  }
}

describe('CompletionPopup', () => {
  it('renders nothing when closed', () => {
    const { container } = render(<CompletionPopup state={state({ open: false })} x={0} y={0} onPick={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders entries, marks dirs and the selected one, highlights matched letters', () => {
    render(<CompletionPopup state={state()} x={10} y={20} onPick={vi.fn()} />)
    const rows = screen.getAllByRole('option')
    expect(rows.map((r) => r.textContent)).toEqual(['src', 'README.md'])
    expect(rows[0]).toHaveClass('dir')
    expect(rows[1]).toHaveAttribute('aria-selected', 'true')
    expect(rows[0]).toHaveAttribute('aria-selected', 'false')
    expect(rows[1].querySelector('b')?.textContent).toBe('R')
    // ↵ без выбора стрелками выполняет строку как есть — подсказка его не обещает.
    expect(screen.getByText('↑↓ выбрать · Tab подставить · esc')).toBeInTheDocument()
  })

  it('says ↵ подставить for other commands only after ↑/↓', () => {
    render(<CompletionPopup state={state({ navigated: true })} x={0} y={0} onPick={vi.fn()} />)
    expect(screen.getByText('↑↓ выбрать · Tab подставить · ↵ подставить · esc')).toBeInTheDocument()
  })

  it('no ↵ hint for cd with an empty name before ↑/↓', () => {
    render(<CompletionPopup state={state({ ctx: completionContext('cd ', 3) })} x={0} y={0} onPick={vi.fn()} />)
    expect(screen.getByText('↑↓ выбрать · Tab подставить · esc')).toBeInTheDocument()
  })

  it('says ↵ перейти for cd', () => {
    render(<CompletionPopup state={state({ ctx: completionContext('cd s', 4) })} x={0} y={0} onPick={vi.fn()} />)
    expect(screen.getByText('↑↓ выбрать · Tab подставить · ↵ перейти · esc')).toBeInTheDocument()
  })

  it('shows a directory preview by names', () => {
    const preview: FsPreviewTS = {
      kind: 'dir',
      entries: [
        { name: 'main.ts', isDir: false, isSymlink: false },
        { name: 'lib', isDir: true, isSymlink: false },
      ],
      total: 5,
    }
    render(<CompletionPopup state={state({ preview })} x={0} y={0} onPick={vi.fn()} />)
    expect(screen.getByText('main.ts')).toBeInTheDocument()
    expect(screen.getByText('lib')).toHaveClass('cp-pdir')
    expect(screen.getByText('… ещё 3')).toBeInTheDocument()
  })

  it('shows a text preview and a preview error', () => {
    const { rerender } = render(
      <CompletionPopup state={state({ preview: { kind: 'text', lines: ['# Title', 'body'], truncated: false } })} x={0} y={0} onPick={vi.fn()} />,
    )
    expect(screen.getByText(/# Title/)).toBeInTheDocument()
    rerender(<CompletionPopup state={state({ preview: { kind: 'error', message: 'Нет доступа' } })} x={0} y={0} onPick={vi.fn()} />)
    expect(screen.getByText('Нет доступа')).toHaveClass('cp-err')
  })

  it('hides the preview when it does not fit', () => {
    const preview: FsPreviewTS = { kind: 'text', lines: ['hello'], truncated: false }
    render(<CompletionPopup state={state({ preview })} x={0} y={0} onPick={vi.fn()} previewFits={false} />)
    expect(screen.queryByText('hello')).not.toBeInTheDocument()
  })

  it('matchPositions: индексы кластеров, NFD-имя по NFC-запросу', () => {
    expect([...matchPositions('src', 'my-src')]).toEqual([3, 4, 5])
    // «й» в NFD — два code point, но один кластер.
    const nfd = 'мой'.normalize('NFD')
    expect([...matchPositions('й', nfd)]).toEqual([2])
    expect([...matchPositions('😀b', 'a😀b')]).toEqual([1, 2])
  })

  it('highlights a surrogate pair and an NFD letter whole', () => {
    const name = 'a😀' + 'й'.normalize('NFD') + 'z'
    const st = state({
      items: [{ name, isDir: false, isSymlink: false }],
      selected: 0,
      ctx: completionContext('ls 😀й', 5),
    })
    render(<CompletionPopup state={st} x={0} y={0} onPick={vi.fn()} />)
    const row = screen.getByRole('option')
    expect(row.textContent).toBe(name)
    expect([...row.querySelectorAll('b')].map((b) => b.textContent)).toEqual(['😀' + 'й'.normalize('NFD')])
  })

  it('picks an entry on click', () => {
    const onPick = vi.fn()
    render(<CompletionPopup state={state()} x={0} y={0} onPick={onPick} />)
    fireEvent.mouseDown(screen.getAllByRole('option')[0])
    expect(onPick).toHaveBeenCalledWith(0)
  })
})
