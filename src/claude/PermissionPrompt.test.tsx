import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Agent, FeedClaudeItem } from './reducer'
import { PERMISSION_KEYS, PermissionPrompt } from './PermissionPrompt'
import { PermissionCard } from './cards/PermissionCard'

type P = Extract<FeedClaudeItem, { type: 'permission' }>
const item = (over: Partial<P> = {}): P => ({
  type: 'permission', requestId: 'p', toolUseId: null, agentId: 'main', tool: 'Bash',
  input: { command: 'git push --force', description: 'Отправить ветку' }, suggestions: null, done: false, ...over,
})
const agent = { id: 'main', name: 'Главный', model: 'claude-opus-5-5' } as Agent

describe('PermissionPrompt', () => {
  it('заголовок, инструмент и команда; без предложений CLI — без «всегда»; клавиши', () => {
    const onDecide = vi.fn()
    const { container } = render(<PermissionPrompt item={item()} agent={agent} onDecide={onDecide} onLeave={vi.fn()} />)
    const box = container.querySelector('.aprompt') as HTMLElement
    expect(box.querySelector('.ap-who')!.textContent).toBe('! Разрешение · Главный · Opus 5.5')
    expect(box.querySelector('.q-text')!.textContent).toBe('Bashgit push --forceОтправить ветку')
    expect(screen.getAllByRole('option').map((r) => r.textContent)).toEqual(['1.Разрешить', '2.Запретить'])
    expect(box.querySelector('.ap-keys')!.textContent).toBe(PERMISSION_KEYS)
    fireEvent.keyDown(box, { key: '2' })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onDecide).toHaveBeenCalledWith('deny')
  })

  it('с предложениями CLI — «Разрешить всегда для этой сессии»', () => {
    const onDecide = vi.fn()
    const { container } = render(<PermissionPrompt item={item({ suggestions: [{}] })} onDecide={onDecide} onLeave={vi.fn()} />)
    expect(screen.getAllByRole('option').map((r) => r.querySelector('.q-l')!.textContent)).toEqual(['Разрешить', 'Разрешить всегда для этой сессии', 'Запретить'])
    const box = container.querySelector('.aprompt') as HTMLElement
    fireEvent.keyDown(box, { key: 'ArrowDown' })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onDecide).toHaveBeenCalledWith('always')
  })

  it('лента: ждёт / разрешено / запрещено / отменено', () => {
    const t = (it: P) => render(<PermissionCard item={it} />).container.textContent
    expect(t(item())).toBe('! Ждёт разрешения: Bash · git push --force')
    expect(t(item({ done: true, decision: 'allow' }))).toBe('✓ Разрешено: Bash · git push --force')
    expect(t(item({ done: true, decision: 'deny' }))).toBe('✕ Запрещено: Bash · git push --force')
    expect(t(item({ cancelled: 'exit' }))).toBe('✕ Запрос отменён (Claude завершился): Bash · git push --force')
  })
})
