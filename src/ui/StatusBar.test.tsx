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

  it('«вложения N» после проекта, только если значки есть (макет 06)', () => {
    const now = new Date(2026, 0, 1, 14, 32)
    const { container, rerender } = render(<StatusBar cwd="/Users/me/shop-app" git={git} now={now} attachments={4} />)
    expect(segs(container).slice(0, 2)).toEqual(['проект shop-app', 'вложения 4'])
    rerender(<StatusBar cwd="/Users/me/shop-app" git={git} now={now} attachments={0} />)
    expect(segs(container).join()).not.toContain('вложения')
  })

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

  it('сессия с bypassPermissions — красная плашка сразу после ◆ CLAUDE; другие режимы и без сессии — нет', () => {
    const c = initialClaude()
    const now = new Date(2026, 0, 1, 9, 5)
    const { container, rerender } = render(<StatusBar git={null} now={now} claude={c} permissionMode="bypassPermissions" />)
    expect(segs(container).slice(0, 2)).toEqual(['◆ CLAUDE', '⚠ БЕЗ РАЗРЕШЕНИЙ'])
    expect(container.querySelector('.sg.danger')).not.toBeNull()
    rerender(<StatusBar git={null} now={now} claude={c} permissionMode="acceptEdits" />)
    expect(container.querySelector('.sg.danger')).toBeNull()
    rerender(<StatusBar git={null} now={now} claude={null} permissionMode="bypassPermissions" />)
    expect(container.querySelector('.sg.danger')).toBeNull()
  })

  it('контекст больше 80% — полоска желтеет; без текущего агента нет «сейчас»', () => {
    const c = { ...initialClaude(), model: 'claude-opus-5-5', contextUsed: 170_000, contextMax: 200_000 }
    const { container } = render(<StatusBar cwd="/x/y" git={null} claude={c} now={new Date(2026, 0, 1, 9, 5)} />)
    expect(screen.getByTestId('context-bar')).toHaveClass('warn')
    expect(container.textContent).not.toContain('сейчас')
    expect(container.textContent).toContain('170k/200k')
  })

  it('открыт файл в просмотре — справа «Имя · строка:столбец · Язык · UTF-8» вместо часов (макет 07)', () => {
    const now = new Date(2026, 0, 1, 14, 32)
    const { container, rerender } = render(
      <StatusBar cwd="/Users/me/shop-app" git={git} now={now} file={{ name: 'PaymentService.kt', line: 10, col: 1 }} />,
    )
    expect(container.querySelector('.sg.right')!.textContent).toBe('PaymentService.kt · 10:1 · Kotlin · UTF-8')
    expect(container.textContent).not.toContain('14:32')
    rerender(<StatusBar cwd="/Users/me/shop-app" git={git} now={now} file={{ name: 'App.tsx', line: 3, col: 1 }} />)
    expect(container.querySelector('.sg.right')!.textContent).toBe('App.tsx · 3:1 · TypeScript · UTF-8')
    rerender(<StatusBar cwd="/Users/me/shop-app" git={git} now={now} file={{ name: 'LICENSE', line: 1, col: 1 }} />)
    expect(container.querySelector('.sg.right')!.textContent).toBe('LICENSE · 1:1 · Текст · UTF-8')
    rerender(<StatusBar cwd="/Users/me/shop-app" git={git} now={now} file={null} />)
    expect(container.querySelector('.sg.right')!.textContent).toBe('14:32')
  })

  it('панель проекта: сводка git после ветки, подсказка клавиш справа (макет 07)', () => {
    const now = new Date(2026, 0, 1, 14, 32)
    const { container, rerender } = render(
      <StatusBar cwd="/Users/me/shop-app" git={git} now={now} project="4 изменено · 1 новый" hint="↑↓ коммиты · → файлы · ↵ изменения" />,
    )
    const s = segs(container)
    expect(s[s.indexOf('⎇ feature/form●') + 1]).toBe('4 изменено · 1 новый')
    expect(container.querySelector('.sg.right')!.textContent).toBe('↑↓ коммиты · → файлы · ↵ изменения')
    rerender(<StatusBar cwd="/Users/me/shop-app" git={git} now={now} project={null} hint={null} />)
    expect(container.textContent).not.toContain('изменено')
    expect(container.querySelector('.sg.right')!.textContent).toBe('14:32')
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

describe('стоимость сессии в статус-баре', () => {
  it('«$0.42» при ненулевой стоимости, без сегмента при нуле', () => {
    const now = new Date(2026, 0, 1, 14, 32)
    const { rerender } = render(<StatusBar git={null} now={now} claude={{ ...initialClaude(), costUsd: 0.42 }} />)
    expect(screen.getByText('$0.42')).toBeTruthy()
    rerender(<StatusBar git={null} now={now} claude={initialClaude()} />)
    expect(screen.queryByText(/^\$/)).toBeNull()
  })
})
