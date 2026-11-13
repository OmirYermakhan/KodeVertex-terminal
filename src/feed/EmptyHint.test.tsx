import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Feed } from './FeedView'
import { emptyHintRows } from './EmptyHint'
import { actionKeys, bindingKeys, INPUT_BINDINGS, isBinding, matchKey } from '../keys/keymap'
import type { ShellBlock } from './feed'

const block: ShellBlock = {
  kind: 'shell',
  id: 'b1',
  command: 'ls',
  cwd: '/tmp',
  startedAt: 0,
  durationMs: 5,
  exitCode: 0,
  running: false,
  html: 'a',
  lines: 1,
} as ShellBlock

describe('подсказка пустой ленты', () => {
  it('клавиши — из настоящих привязок', () => {
    expect(emptyHintRows().map((r) => [r.label, (r.keys ?? [r.command]).join(' ')])).toEqual([
      ['Команда', '↵'],
      ['Спросить Claude', '⌘ ↵'],
      ['Режим карточек Claude', 'claude'],
      ['Палитра команд', '⌘ P'],
      ['История команд', '⌃ R'],
      ['Разделить панель', '⌘ D'],
    ])
    // ⌘P и ⌘D действительно открывают палитру и делят панель.
    const ev = (code: string, m: Partial<KeyboardEvent> = {}) => ({ key: '', code, metaKey: false, shiftKey: false, altKey: false, ctrlKey: false, ...m })
    expect(matchKey(ev('KeyP', { metaKey: true }))).toBe('palette')
    expect(matchKey(ev('KeyD', { metaKey: true }))).toBe('splitRight')
    expect(isBinding(INPUT_BINDINGS.history, ev('KeyR', { ctrlKey: true }))).toBe(true)
    expect(isBinding(INPUT_BINDINGS.history, ev('KeyR', { ctrlKey: true, shiftKey: true }))).toBe(false)
  })

  it('порядок модификаторов как в макете: ⌥ ⌘ ←, ⌘ ⇧ D', () => {
    expect(actionKeys('focusLeft')).toEqual(['⌥', '⌘', '←'])
    expect(actionKeys('splitDown')).toEqual(['⌘', '⇧', 'D'])
    expect(bindingKeys({ key: 'Digit1', meta: true })).toEqual(['⌘', '1'])
  })

  it('пустая лента — карточка по центру; с первым блоком исчезает', () => {
    const { container, rerender } = render(<Feed items={[]} selectedId={null} renderLive={() => null} />)
    expect(container.querySelector('.feed-empty .ks h3')!.textContent).toBe('С чего начать')
    expect(container.querySelectorAll('.ks li')).toHaveLength(6)
    expect(container.querySelector('.ks .kbd')!.textContent).toBe('↵')
    rerender(<Feed items={[block]} selectedId={null} renderLive={() => null} />)
    expect(container.querySelector('.feed-empty')).toBeNull()
  })

  it('и с первой карточкой Claude', () => {
    const { container } = render(
      <Feed items={[{ kind: 'claude', id: 'c1', item: { type: 'user', text: 'привет' } }]} selectedId={null} renderLive={() => null} />,
    )
    expect(container.querySelector('.feed-empty')).toBeNull()
  })
})
