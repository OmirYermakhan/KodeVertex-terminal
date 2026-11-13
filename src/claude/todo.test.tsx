import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { initialClaude, reduceClaude, type ClaudeState } from './reducer'
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
