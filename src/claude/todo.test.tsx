import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { clearSession, freezeTodos, initialClaude, reduceClaude, type ClaudeState } from './reducer'
import { TodoCard } from './cards/TodoCard'

const todoWrite = (id: string, todos: unknown[], parent: string | null = null) => ({
  type: 'assistant',
  parent_tool_use_id: parent,
  message: { model: 'm', content: [{ type: 'tool_use', id, name: 'TodoWrite', input: { todos } }] },
})
const text = (t: string) => ({ type: 'assistant', parent_tool_use_id: null, message: { model: 'm', content: [{ type: 'text', text: t }] } })

describe('план (TodoWrite)', () => {
  it('одна карточка на агента: следующий TodoWrite обновляет её на месте, действие не добавляется', () => {
    let s: ClaudeState = initialClaude()
    s = reduceClaude(s, todoWrite('t1', [{ content: 'Тесты', status: 'in_progress', activeForm: 'Пишу тесты' }, { content: 'Код', status: 'pending' }]), 1)
    s = reduceClaude(s, text('Начинаю'), 2)
    s = reduceClaude(s, todoWrite('t2', [{ content: 'Тесты', status: 'completed' }, { content: 'Код', status: 'in_progress' }]), 3)
    expect(s.items.map((x) => x.type)).toEqual(['todo', 'assistant'])
    expect(s.items[0]).toEqual({
      type: 'todo',
      agentId: 'main',
      toolUseId: 't2',
      todos: [
        { content: 'Тесты', status: 'completed' },
        { content: 'Код', status: 'in_progress' },
      ],
    })
    // Шаг агента по-прежнему считается.
    expect(s.agents.find((a) => a.id === 'main')?.step).toEqual({ n: 2, m: 2 })
  })

  it('у субагента — своя карточка; мусорные пункты пропускаются', () => {
    let s = reduceClaude(initialClaude(), todoWrite('t1', [{ content: 'A', status: 'pending' }]), 1)
    s = reduceClaude(s, todoWrite('t2', [{ content: 'B', status: 'weird' }, { status: 'pending' }, 5]), 2)
    s = reduceClaude(s, todoWrite('t3', [{ content: 'C', status: 'completed' }], 'sub1'), 3)
    expect(s.items).toHaveLength(2)
    expect(s.items[0]).toMatchObject({ agentId: 'main', todos: [{ content: 'B', status: 'pending' }] })
    expect(s.items[1]).toMatchObject({ agentId: 'sub1', todos: [{ content: 'C', status: 'completed' }] })
  })

  it('ответ на TodoWrite возвращает агента из «ждёт» в «работает»', () => {
    let s = reduceClaude(initialClaude(), todoWrite('t1', [{ content: 'A', status: 'pending' }]), 1)
    s = { ...s, agents: s.agents.map((a) => (a.id === 'main' ? { ...a, status: 'waiting' as const } : a)) }
    s = reduceClaude(s, { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }, 2)
    expect(s.agents.find((a) => a.id === 'main')?.status).toBe('running')
  })

  it('после ⌃L (и /clear) следующий TodoWrite — новая карточка внизу, дальше обновляется она', () => {
    let s = reduceClaude(initialClaude(), todoWrite('t1', [{ content: 'A', status: 'pending' }]), 1)
    s = reduceClaude(s, text('ответ'), 2)
    s = freezeTodos(s, s.items.length)
    expect(s.items[0]).toMatchObject({ type: 'todo', frozen: true })
    s = reduceClaude(s, todoWrite('t2', [{ content: 'A', status: 'in_progress' }]), 3)
    s = reduceClaude(s, todoWrite('t3', [{ content: 'A', status: 'completed' }]), 4)
    expect(s.items.map((x) => x.type)).toEqual(['todo', 'assistant', 'todo'])
    expect(s.items[0]).toMatchObject({ todos: [{ status: 'pending' }] })
    expect(s.items[2]).toMatchObject({ toolUseId: 't3', todos: [{ status: 'completed' }] })
    // Карточки после границы не замораживаются.
    expect(freezeTodos(s, 2).items[2]).not.toHaveProperty('frozen')
    expect(clearSession(s).items[2]).toMatchObject({ frozen: true })
  })

  it('карточка: «План · n из m», ☐/◐/☑ и классы состояний', () => {
    const { container } = render(
      <TodoCard
        todos={[
          { content: 'Тесты', status: 'completed' },
          { content: 'Код', status: 'in_progress' },
          { content: 'README', status: 'pending' },
        ]}
      />,
    )
    expect(container.querySelector('.plan .who')?.textContent).toBe('План · 1 из 3')
    const rows = Array.from(container.querySelectorAll('.plan-i'), (li) => [li.className, li.textContent])
    expect(rows).toEqual([
      ['plan-i completed', '☑Тесты'],
      ['plan-i in_progress', '◐Код'],
      ['plan-i pending', '☐README'],
    ])
  })
})
