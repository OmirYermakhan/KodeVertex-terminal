import { describe, expect, it, vi } from 'vitest'
import { emitClaudeEvent, finishedTools, onClaudeEvent } from './toolEvents'
import { initialClaude, reduceClaude, type ClaudeState } from './reducer'

const use = (id: string, name: string, input: Record<string, unknown>) =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } })
const result = (id: string, isError = false) =>
  JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', is_error: isError }] } })
const feed = (s: ClaudeState, ...lines: string[]) => lines.reduce((x, l) => reduceClaude(x, l, 1), s)

describe('finishedTools', () => {
  it('Edit/Write/MultiEdit/NotebookEdit/Bash, закончившиеся в этом шаге: путь и успех', () => {
    const s0 = feed(
      initialClaude(),
      use('e', 'Edit', { file_path: '/r/a.ts', old_string: 'x', new_string: 'y' }),
      use('w', 'Write', { file_path: '/r/b.ts', content: '' }),
      use('n', 'NotebookEdit', { notebook_path: '/r/c.ipynb', new_source: '' }),
      use('b', 'Bash', { command: 'rm x' }),
      use('r', 'Read', { file_path: '/r/a.ts' }),
    )
    const s1 = feed(s0, result('e'), result('w', true), result('n'), result('b'), result('r'))
    expect(finishedTools(s0, s1)).toEqual([
      { tool: 'Edit', path: '/r/a.ts', ok: true },
      { tool: 'Write', path: '/r/b.ts', ok: false },
      { tool: 'NotebookEdit', path: '/r/c.ipynb', ok: true },
      { tool: 'Bash', path: null, ok: true },
    ])
  })

  it('уже законченное действие второй раз не попадает; без изменений — пусто', () => {
    const s0 = feed(initialClaude(), use('e', 'Edit', { file_path: '/r/a.ts', old_string: 'x', new_string: 'y' }))
    const s1 = feed(s0, result('e'))
    expect(finishedTools(s1, s1)).toEqual([])
    expect(finishedTools(s0, s0)).toEqual([])
  })
})

describe('onClaudeEvent', () => {
  it('подписка получает события, отписка прекращает', () => {
    const f = vi.fn()
    const off = onClaudeEvent(f)
    emitClaudeEvent({ kind: 'cleared' })
    off()
    emitClaudeEvent({ kind: 'cleared' })
    expect(f).toHaveBeenCalledTimes(1)
    expect(f).toHaveBeenCalledWith({ kind: 'cleared' })
  })
})
