import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { initialClaude, reduceClaude, thinkingSince, userSent } from './reducer'
import { ThinkingRow, elapsedLabel } from './cards/ThinkingRow'

const delta = (text: string) => ({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } })
const tool = (id: string) => ({ type: 'assistant', parent_tool_use_id: null, message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } }] } })
const toolDone = (id: string) => ({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } })

describe('thinkingSince', () => {
  it('нет хода — нет индикатора', () => {
    expect(thinkingSince(initialClaude())).toBeNull()
  })
  it('сразу после отправки — время хода', () => {
    expect(thinkingSince(userSent(initialClaude(), 'привет', 5000))).toBe(5000)
  })
  it('пошёл текст ответа — индикатор прячется', () => {
    const s = reduceClaude(userSent(initialClaude(), 'привет', 5000), delta('Здра'), 5100)
    expect(thinkingSince(s)).toBeNull()
  })
  it('идёт инструмент — свой спиннер, индикатора нет; инструмент закончился — снова думает', () => {
    let s = reduceClaude(userSent(initialClaude(), 'ls', 5000), tool('t1'), 5100)
    expect(thinkingSince(s)).toBeNull()
    s = reduceClaude(s, toolDone('t1'), 5200)
    expect(thinkingSince(s)).toBe(5000)
  })
  it('конец хода — нет индикатора', () => {
    const s = reduceClaude(userSent(initialClaude(), 'привет', 5000), { type: 'result', subtype: 'success', is_error: false, result: 'ok' }, 6000)
    expect(thinkingSince(s)).toBeNull()
  })
})

describe('ThinkingRow', () => {
  it('подписи времени', () => {
    expect(elapsedLabel(400)).toBe('0 с')
    expect(elapsedLabel(12_900)).toBe('12 с')
    expect(elapsedLabel(65_000)).toBe('1 мин 05 с')
  })
  it('показывает «Думает» и как прервать', () => {
    render(<ThinkingRow since={Date.now() - 3000} />)
    expect(screen.getByRole('status').textContent).toContain('Думает')
    expect(screen.getByRole('status').textContent).toContain('3 с')
    expect(screen.getByRole('status').textContent).toContain('⌃C')
  })
})
