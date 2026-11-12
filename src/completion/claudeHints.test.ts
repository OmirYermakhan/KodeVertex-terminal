import { describe, expect, it } from 'vitest'
import {
  applyHint,
  BUILTIN_SLASH,
  CLAUDE_OPTIONS,
  customSlashItems,
  hintContext,
  rankHints,
  type HintContext,
} from './claudeHints'

const labels = (ctx: HintContext | null, items = CLAUDE_OPTIONS) =>
  rankHints(ctx!, items).map((r) => r.item.aliases[r.alias])

describe('hintContext', () => {
  it('оболочка: claude, claude␠, первый аргумент', () => {
    expect(hintContext('claude', 6, 'shell')).toEqual({ kind: 'claude', tokenStart: 6, token: '', bare: true })
    expect(hintContext('claude ', 7, 'shell')).toEqual({ kind: 'claude', tokenStart: 7, token: '', bare: false })
    expect(hintContext('claude --t', 10, 'shell')).toEqual({ kind: 'claude', tokenStart: 7, token: '--t', bare: false })
  })

  it('оболочка: не открывается на втором аргументе, других командах, не в конце строки, многострочно', () => {
    expect(hintContext('claude --tui ', 13, 'shell')).toBeNull()
    expect(hintContext('claude объясни это', 18, 'shell')).toBeNull()
    expect(hintContext('claudette', 9, 'shell')).toBeNull()
    expect(hintContext('echo claude ', 12, 'shell')).toBeNull()
    expect(hintContext('claude mcp', 3, 'shell')).toBeNull()
    expect(hintContext('claude \nx', 7, 'shell')).toBeNull()
    expect(hintContext('/mo', 3, 'shell')).toBeNull()
  })

  it('режим Claude: / в начале строки', () => {
    expect(hintContext('/', 1, 'claude')).toEqual({ kind: 'slash', tokenStart: 0, token: '/', bare: false })
    expect(hintContext('/mo', 3, 'claude')).toEqual({ kind: 'slash', tokenStart: 0, token: '/mo', bare: false })
    expect(hintContext('/model x', 8, 'claude')).toBeNull()
    expect(hintContext(' /x', 3, 'claude')).toBeNull()
    expect(hintContext('claude', 6, 'claude')).toBeNull()
  })
})

describe('rankHints', () => {
  it('ровно claude — весь список и первой строкой «открыть режим»', () => {
    const rows = rankHints(hintContext('claude', 6, 'shell')!, CLAUDE_OPTIONS)
    expect(rows[0].item.enter).toBe(true)
    expect(rows.map((r) => r.item.group)).toEqual(['card', 'tui', 'tui', 'tui', ...Array(7).fill('service')])
    expect(labels(hintContext('claude ', 7, 'shell'))).toHaveLength(CLAUDE_OPTIONS.length)
  })

  it('фильтрует по набранному, группы сохраняют порядок', () => {
    expect(labels(hintContext('claude --c', 10, 'shell'))).toEqual(['--continue'])
    expect(labels(hintContext('claude -r', 9, 'shell'))).toEqual(['-r', '--version'])
    expect(labels(hintContext('claude doc', 10, 'shell'))).toEqual(['doctor'])
    expect(labels(hintContext('claude привет', 13, 'shell'))).toEqual([])
  })

  it('slash: встроенные, затем проектные и личные', () => {
    const items = [
      ...BUILTIN_SLASH,
      ...customSlashItems([
        { name: 'deploy', description: 'Выкатить', source: 'user' },
        { name: 'git:sync', description: '', source: 'project' },
        { name: 'bad name', description: '', source: 'project' },
      ]),
    ]
    const all = rankHints(hintContext('/', 1, 'claude')!, items)
    expect(all.map((r) => r.item.aliases[0]).slice(-2)).toEqual(['/git:sync', '/deploy'])
    expect(all).toHaveLength(BUILTIN_SLASH.length + 2)
    expect(labels(hintContext('/mod', 4, 'claude'), items)).toEqual(['/model'])
    expect(labels(hintContext('/co', 3, 'claude'), items)).toEqual(['/cost', '/compact', '/context'])
  })
})

describe('applyHint', () => {
  it('подставляет токен с пробелом', () => {
    const ctx = hintContext('claude --c', 10, 'shell')!
    const [row] = rankHints(ctx, CLAUDE_OPTIONS)
    expect(applyHint('claude --c', ctx, row)).toEqual({ value: 'claude --continue ', cursor: 18 })
  })

  it('после ровно claude добавляет пробел', () => {
    const ctx = hintContext('claude', 6, 'shell')!
    const row = rankHints(ctx, CLAUDE_OPTIONS)[1]
    expect(applyHint('claude', ctx, row).value).toBe('claude --tui ')
    // Строка «открыть режим» ничего не меняет.
    expect(applyHint('claude', ctx, rankHints(ctx, CLAUDE_OPTIONS)[0]).value).toBe('claude')
  })

  it('slash', () => {
    const ctx = hintContext('/cle', 4, 'claude')!
    const [row] = rankHints(ctx, BUILTIN_SLASH)
    expect(applyHint('/cle', ctx, row)).toEqual({ value: '/clear ', cursor: 7 })
  })
})
