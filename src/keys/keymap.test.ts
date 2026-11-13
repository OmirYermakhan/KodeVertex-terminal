import { describe, expect, it } from 'vitest'
import { matchKey } from './keymap'

const ev = (o: Partial<Parameters<typeof matchKey>[0]>) => ({
  key: '',
  code: '',
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  ...o,
})

describe('matchKey', () => {
  it('matches by code, so the Russian layout works', () => {
    expect(matchKey(ev({ code: 'KeyD', key: 'в', metaKey: true }))).toBe('splitRight')
    expect(matchKey(ev({ code: 'KeyD', key: 'в', metaKey: true, shiftKey: true }))).toBe('splitDown')
  })
  it('new tab / close pane', () => {
    expect(matchKey(ev({ code: 'KeyT', metaKey: true }))).toBe('newTab')
    expect(matchKey(ev({ code: 'KeyW', metaKey: true }))).toBe('closePane')
  })
  it('⌘F — поиск в ленте (и в русской раскладке)', () => {
    expect(matchKey(ev({ code: 'KeyF', key: 'а', metaKey: true }))).toBe('find')
    expect(matchKey(ev({ code: 'KeyF', ctrlKey: true }))).toBeNull()
  })
  it('focus with alt+cmd+arrows', () => {
    expect(matchKey(ev({ code: 'ArrowLeft', metaKey: true, altKey: true }))).toBe('focusLeft')
    expect(matchKey(ev({ code: 'ArrowRight', metaKey: true, altKey: true }))).toBe('focusRight')
    expect(matchKey(ev({ code: 'ArrowUp', metaKey: true, altKey: true }))).toBe('focusUp')
    expect(matchKey(ev({ code: 'ArrowDown', metaKey: true, altKey: true }))).toBe('focusDown')
    expect(matchKey(ev({ code: 'ArrowLeft', metaKey: true }))).toBeNull()
  })
  it('tabs by digit', () => {
    expect(matchKey(ev({ code: 'Digit3', metaKey: true }))).toBe('tab3')
    expect(matchKey(ev({ code: 'Digit9', metaKey: true }))).toBe('tab9')
    expect(matchKey(ev({ code: 'Digit0', metaKey: true }))).toBe('fontReset')
  })
  it('prev/next tab', () => {
    expect(matchKey(ev({ code: 'BracketLeft', metaKey: true, shiftKey: true }))).toBe('prevTab')
    expect(matchKey(ev({ code: 'BracketRight', metaKey: true, shiftKey: true }))).toBe('nextTab')
  })
  it('font size and settings', () => {
    expect(matchKey(ev({ code: 'Equal', metaKey: true }))).toBe('fontBigger')
    expect(matchKey(ev({ code: 'Equal', metaKey: true, shiftKey: true }))).toBe('fontBigger')
    expect(matchKey(ev({ code: 'Minus', metaKey: true }))).toBe('fontSmaller')
    expect(matchKey(ev({ code: 'Comma', metaKey: true }))).toBe('openSettings')
    expect(matchKey(ev({ code: 'KeyA', metaKey: true, shiftKey: true }))).toBe('blockAsk')
    // ⌘A (выделить всё) не занят.
    expect(matchKey(ev({ code: 'KeyA', metaKey: true }))).toBeNull()
  })
  it('leaves shell and clipboard keys alone', () => {
    expect(matchKey(ev({ code: 'KeyD', ctrlKey: true }))).toBeNull()
    expect(matchKey(ev({ code: 'KeyC', metaKey: true }))).toBeNull()
    expect(matchKey(ev({ code: 'KeyV', metaKey: true }))).toBeNull()
    expect(matchKey(ev({ code: 'KeyD' }))).toBeNull()
  })
})

describe('block keys', () => {
  it('⌘↑/⌘↓ выбор блока, ⌘⇧C копирование', () => {
    expect(matchKey(ev({ code: 'ArrowUp', metaKey: true }))).toBe('blockPrev')
    expect(matchKey(ev({ code: 'ArrowDown', metaKey: true }))).toBe('blockNext')
    expect(matchKey(ev({ code: 'KeyC', key: 'с', metaKey: true, shiftKey: true }))).toBe('blockCopy')
    expect(matchKey(ev({ code: 'KeyC', metaKey: true }))).toBeNull()
  })
})

describe('agents panel keys', () => {
  it('⌘J скрывает/показывает панель агентов (в любой раскладке)', () => {
    expect(matchKey(ev({ code: 'KeyJ', key: 'о', metaKey: true }))).toBe('toggleAgents')
    expect(matchKey(ev({ code: 'KeyJ', key: 'j' }))).toBeNull()
  })
})
