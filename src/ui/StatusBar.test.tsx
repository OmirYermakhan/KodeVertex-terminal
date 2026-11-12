import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { projectName, shortPath } from '../status/useGitInfo'
import StatusBar from './StatusBar'
import { mockupScene } from '../claude/fixtures/mockupScene'
import { initialClaude, reduceClaude } from '../claude/reducer'

vi.mock('@tauri-apps/api/path', () => ({ homeDir: () => Promise.resolve('/Users/me') }))

const git = { root: '/Users/me/shop-app', branch: 'feature/form', dirty: true }

describe('helpers', () => {
  it('projectName uses git root folder', () => {
    expect(projectName('/Users/me/shop-app/src', git)).toBe('shop-app')
  })
  it('projectName falls back to cwd folder', () => {
    expect(projectName('/Users/me/notes', null)).toBe('notes')
  })
  it('shortPath replaces home with ~', () => {
    expect(shortPath('/Users/me/x', '/Users/me')).toBe('~/x')
    expect(shortPath('/Users/me', '/Users/me')).toBe('~')
    expect(shortPath('/Users/meow/x', '/Users/me')).toBe('/Users/meow/x')
  })
})

describe('StatusBar', () => {
  const segs = (c: HTMLElement) => Array.from(c.querySelectorAll('.sg')).map((x) => x.textContent)

  it('без Claude-сессии: проект, ветка, отметка изменений и время справа — без сегментов Claude', () => {
    const { container } = render(
      <StatusBar cwd="/Users/me/shop-app/src" git={git} now={new Date(2026, 0, 1, 14, 32)} />,
    )
    expect(segs(container)).toEqual(['проект shop-app', '⎇ feature/form●', '14:32'])
    expect(screen.getByLabelText('есть изменения')).toBeInTheDocument()
    expect(container.querySelector('.sg.right')!.textContent).toBe('14:32')
    expect(container.querySelector('.sg.v')).toBeNull()
  })

  it('с сессией — как в макете: ◆ CLAUDE · сейчас · проект · ветка · модель · контекст · время', () => {
    const { container } = render(
      <StatusBar
        cwd="/Users/me/shop-app"
        git={{ ...git, branch: 'feature/payments', dirty: false }}
        claude={mockupScene()}
        now={new Date(2026, 0, 1, 14, 32)}
      />,
    )
    expect(segs(container)).toEqual([
      '◆ CLAUDE',
      'сейчас Архитектор',
      'проект shop-app',
      '⎇ feature/payments',
      'модель Opus 5.5',
      'контекст84k/200k',
      '14:32',
    ])
    expect(container.querySelector('.sg.v')!.textContent).toBe('◆ CLAUDE')
    const bar = screen.getByTestId('context-bar')
    expect(bar).not.toHaveClass('warn')
    expect((bar.firstChild as HTMLElement).style.width).toBe('42%')
  })

  it('контекст больше 80% — полоска желтеет; без текущего агента нет «сейчас»', () => {
    const c = { ...initialClaude(), model: 'claude-opus-5-5', contextUsed: 170_000, contextMax: 200_000 }
    const { container } = render(<StatusBar cwd="/x/y" git={null} claude={c} now={new Date(2026, 0, 1, 9, 5)} />)
    expect(screen.getByTestId('context-bar')).toHaveClass('warn')
    expect(container.textContent).not.toContain('сейчас')
    expect(container.textContent).toContain('170k/200k')
  })

  it('omits the branch segment without git', () => {
    const { container } = render(<StatusBar cwd="/tmp/x" git={null} now={new Date(2026, 0, 1, 9, 5)} />)
    expect(container.textContent).not.toContain('⎇')
    expect(screen.getByText('09:05')).toBeInTheDocument()
  })

  it('shows ~ as the project in the home folder without git', async () => {
    render(<StatusBar cwd="/Users/me" git={null} now={new Date(2026, 0, 1, 9, 5)} />)
    expect(await screen.findByText('~', { selector: 'b' })).toBeInTheDocument()
    expect(screen.queryByText('me', { selector: 'b' })).toBeNull()
  })
})

describe('StatusBar: смена модели', () => {
  it('ответ set_model сразу меняет сегмент «модель»', () => {
    const before = { ...initialClaude(), model: 'claude-opus-5-5' }
    const after = reduceClaude(
      before,
      { type: 'control_response', response: { subtype: 'success', request_id: 'kv-1', response: { model: 'claude-fable-5-2' } } },
      0,
    )
    const { container, rerender } = render(<StatusBar git={null} now={new Date(0)} claude={before} />)
    expect(container.textContent).toContain('модель Opus 5.5')
    rerender(<StatusBar git={null} now={new Date(0)} claude={after} />)
    expect(container.textContent).toContain('модель Fable 5.2')
  })
})
