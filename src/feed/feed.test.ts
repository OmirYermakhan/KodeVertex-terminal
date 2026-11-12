import { describe, expect, it } from 'vitest'
import { applyShell, commandBytes, COLLAPSE_LINES, formatDuration, moveSelection, parseOsc133, syncClaude, type FeedItem, type ShellBlock } from './feed'
import type { FeedClaudeItem } from '../claude/reducer'

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)))

describe('parseOsc133', () => {
  it('A -> prompt', () => expect(parseOsc133('A')).toEqual({ t: 'prompt' }))
  it('C -> команда', () => expect(parseOsc133('C;ZWNobyBoaQ==')).toEqual({ t: 'start', command: 'echo hi' }))
  it('C с кириллицей (UTF-8)', () =>
    expect(parseOsc133('C;' + b64('echo привет'))).toEqual({ t: 'start', command: 'echo привет' }))
  it('D -> код', () => expect(parseOsc133('D;127')).toEqual({ t: 'end', exitCode: 127 }))
  it('мусор -> null', () => {
    for (const s of ['', 'X', 'D;abc', 'D', 'C;!!!', 'C', 'A;1x']) expect(parseOsc133(s)).toBeNull()
  })
})

const start = (command: string, at: number) => ({ t: 'start' as const, command, cwd: '/w', at })
const end = (at: number, exitCode = 0) => ({ t: 'end' as const, exitCode, at, html: '<b>x</b>', lines: 3 })
const sh = (items: FeedItem[], i: number) => items[i] as ShellBlock

describe('applyShell', () => {
  it('start добавляет running-блок', () => {
    const r = applyShell([], start('ls', 100))
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ kind: 'shell', command: 'ls', cwd: '/w', startedAt: 100, running: true, exitCode: null, durationMs: null, html: null })
  })
  it('end закрывает последний running', () => {
    const r = applyShell(applyShell([], start('ls', 100)), end(350, 2))
    expect(sh(r, 0)).toMatchObject({ running: false, exitCode: 2, durationMs: 250, html: '<b>x</b>', lines: 3 })
  })
  it('end без start игнорируется', () => {
    const items: FeedItem[] = []
    expect(applyShell(items, end(1))).toEqual([])
    const done = applyShell(applyShell([], start('a', 0)), end(5))
    expect(applyShell(done, end(9))).toEqual(done)
  })
  it('prompt ничего не меняет', () => {
    const items = applyShell([], start('a', 0))
    expect(applyShell(items, { t: 'prompt' })).toEqual(items)
  })
  it('start при running закрывает прежний с exitCode null', () => {
    const r = applyShell(applyShell([], start('a', 100)), start('b', 400))
    expect(r).toHaveLength(2)
    expect(sh(r, 0)).toMatchObject({ running: false, exitCode: null, durationMs: 300 })
    expect(sh(r, 1)).toMatchObject({ running: true, command: 'b' })
    expect(r.filter((x) => x.kind === 'shell' && x.running)).toHaveLength(1)
    expect(sh(r, 0).id).not.toBe(sh(r, 1).id)
  })
  it('не мутирует вход', () => {
    const a = applyShell([], start('a', 0))
    const snap = JSON.stringify(a)
    applyShell(a, end(5))
    expect(JSON.stringify(a)).toBe(snap)
  })
  it('end закрывает running после claude-элемента', () => {
    const items: FeedItem[] = [...applyShell([], start('a', 0)), { kind: 'claude', id: 'c', item: { type: 'user', text: 'hi' } }]
    expect(sh(applyShell(items, end(5)), 0).running).toBe(false)
  })
})

describe('formatDuration', () => {
  it('примеры', () => {
    expect(formatDuration(80)).toBe('0.1 с')
    expect(formatDuration(1500)).toBe('1.5 с')
    expect(formatDuration(65000)).toBe('1м 05с')
  })
  it('граница минуты', () => expect(formatDuration(60000)).toBe('1м 00с'))
  it('константа', () => expect(COLLAPSE_LINES).toBe(2000))
})

describe('moveSelection', () => {
  const blk = (id: string, running = false): ShellBlock => ({
    kind: 'shell', id, command: id, cwd: '/w', startedAt: 0, durationMs: 1, exitCode: 0, html: '', lines: 0, running,
  })
  const items: FeedItem[] = [blk('a'), { kind: 'claude', id: 'c', item: { type: 'user', text: 'hi' } }, blk('b'), blk('r', true)]
  it('⌘↑ без выбора — последний завершённый блок, дальше вверх до первого', () => {
    expect(moveSelection(items, null, 'up')).toEqual({ id: 'b', leave: false })
    expect(moveSelection(items, 'b', 'up')).toEqual({ id: 'a', leave: false })
    expect(moveSelection(items, 'a', 'up')).toEqual({ id: 'a', leave: false })
  })
  it('⌘↓ вниз; с последнего — снять выбор и уйти из ленты', () => {
    expect(moveSelection(items, 'a', 'down')).toEqual({ id: 'b', leave: false })
    expect(moveSelection(items, 'b', 'down')).toEqual({ id: null, leave: true })
    expect(moveSelection(items, null, 'down')).toEqual({ id: null, leave: true })
  })
  it('пустая лента', () => expect(moveSelection([], null, 'up')).toEqual({ id: null, leave: false }))
  it('ответы Claude тоже выбираются (для ⌘L); идущий ответ — нет', () => {
    const ans = (id: string, streaming: boolean): FeedItem => ({ kind: 'claude', id, item: { type: 'assistant', agentId: 'main', text: 'ок', streaming } })
    const list: FeedItem[] = [blk('a'), ans('m1', false), ans('m2', true)]
    expect(moveSelection(list, null, 'up')).toEqual({ id: 'm1', leave: false })
    expect(moveSelection(list, 'm1', 'up')).toEqual({ id: 'a', leave: false })
  })
})

describe('id блоков', () => {
  it('уникальны и после очистки ленты', () => {
    const a = applyShell([], { t: 'start', command: 'a', cwd: '/', at: 5 })
    const b = applyShell([], { t: 'start', command: 'b', cwd: '/', at: 5 })
    expect(a[0].id).not.toBe(b[0].id)
  })
})

describe('syncClaude', () => {
  const u = (text: string): FeedClaudeItem => ({ type: 'user', text })
  it('новые — в конец, изменённые — на месте, до from — не показываются', () => {
    const shell = applyShell([], { t: 'start', command: 'ls', cwd: '/', at: 1 })
    const c1 = [u('q')]
    let feed = syncClaude(shell, [], c1)
    expect(feed.map((f) => f.id)).toEqual([shell[0].id, 'cl-0'])
    feed = applyShell(feed, { t: 'end', exitCode: 0, at: 2, html: '', lines: 0 })
    feed = applyShell(feed, { t: 'start', command: 'pwd', cwd: '/', at: 3 })
    const c2 = [u('q2'), u('r')]
    feed = syncClaude(feed, c1, c2)
    expect(feed.map((f) => (f.kind === 'claude' ? (f.item as { text: string }).text : f.command))).toEqual(['ls', 'q2', 'pwd', 'r'])
    expect(syncClaude(feed, c2, c2)).toBe(feed)
    expect(syncClaude([], c2, [...c2, u('x')], 3)).toEqual([])
    expect(syncClaude([], c2, [...c2, u('x')], 2).map((f) => f.id)).toEqual(['cl-2'])
  })
})

describe('commandBytes и PS2', () => {
  it('всегда bracketed paste; ESC и прочие C0/C1 вырезаются, \t и \n остаются', () => {
    expect(commandBytes('ls')).toBe('\x1b[200~ls\x1b[201~\r')
    expect(commandBytes('echo a\x1b[201~; rm x\x03\r')).toBe('\x1b[200~echo a[201~; rm x\x1b[201~\r')
    expect(commandBytes('a\tb\nc\x7f\x9b')).toBe('\x1b[200~a\tb\nc\x1b[201~\r')
  })
  it('133;A;k=s — вторичное приглашение', () => {
    expect(parseOsc133('A;k=s')).toEqual({ t: 'continue' })
    expect(parseOsc133('A;aid=1')).toEqual({ t: 'prompt' })
  })
})
