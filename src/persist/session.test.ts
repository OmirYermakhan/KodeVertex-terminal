import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...a: unknown[]) => invoke(...a),
  Channel: class {
    onmessage: (m: unknown) => void
    constructor(f: (m: unknown) => void) {
      this.onmessage = f
    }
  },
}))

const { applySession, restoredPane, resetPersistForTests, serializeCapped, setPaneFeed, snapshot, saveNow, finalSave, restoreSession, SESSION_VERSION } = await import('./session')
const { useTabs } = await import('../layout/tabsStore')
const { askClaude, useClaudeSessions, stopClaude, RESTORED_NOTE } = await import('../claude/sessionStore')
const { initialClaude } = await import('../claude/reducer')
type ShellBlock = import('../feed/feed').ShellBlock

const flush = () => new Promise((r) => setTimeout(r, 0))
const calls = (cmd: string) => invoke.mock.calls.filter((c) => c[0] === cmd)

const block = (id: string, startedAt: number, over: Partial<ShellBlock> = {}): ShellBlock => ({
  kind: 'shell',
  id,
  command: `cmd ${id}`,
  cwd: '/w',
  startedAt,
  durationMs: 5,
  exitCode: 0,
  html: '<span>out</span>',
  lines: 1,
  running: false,
  ...over,
})

const tab = (id: string, panes: string[], cwd: Record<string, string> = {}) => ({
  id,
  tree:
    panes.length === 1
      ? { kind: 'leaf' as const, id: panes[0] }
      : { kind: 'split' as const, axis: 'row' as const, ratio: 0.3, a: { kind: 'leaf' as const, id: panes[0] }, b: { kind: 'leaf' as const, id: panes[1] } },
  focused: panes[panes.length - 1],
  cwd,
})

beforeEach(() => {
  resetPersistForTests()
  invoke.mockReset()
  invoke.mockImplementation((cmd: string) => Promise.resolve(cmd === 'claude_start' ? 'proc-1' : undefined))
  useClaudeSessions.setState({ sessions: {} })
})

describe('снимок и восстановление вкладок', () => {
  it('раскладка, активная вкладка и каталоги панелей возвращаются как были', () => {
    useTabs.setState({ tabs: [tab('t1', ['a']), tab('t2', ['b', 'c'], { b: '/x', c: '/y' })], active: 't2', respawns: [] })
    const saved = JSON.parse(JSON.stringify(snapshot()))
    expect(saved.version).toBe(SESSION_VERSION)
    useTabs.setState({ tabs: [tab('z', ['q'])], active: 'z' })
    expect(applySession(saved)).toBe(true)
    const s = useTabs.getState()
    expect(s.active).toBe('t2')
    expect(s.tabs.map((t) => t.id)).toEqual(['t1', 't2'])
    expect(s.tabs[1].tree).toEqual(tab('t2', ['b', 'c']).tree)
    expect(s.tabs[1].cwd).toEqual({ b: '/x', c: '/y' })
  })

  it('чужая версия, битая форма или пусто — сессия не применяется', () => {
    useTabs.setState({ tabs: [tab('z', ['q'])], active: 'z' })
    expect(applySession(null)).toBe(false)
    expect(applySession({ version: 999, tabs: [tab('t', ['a'])], active: 't', panes: {} })).toBe(false)
    expect(applySession({ version: SESSION_VERSION, tabs: [{ id: 'x', tree: { kind: 'leaf' }, focused: 'x', cwd: {} }], active: 'x', panes: {} })).toBe(false)
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(['z'])
  })

  it('неизвестная активная вкладка — первая', () => {
    applySession({ version: SESSION_VERSION, tabs: [tab('t1', ['a'])], active: 'nope', panes: {} })
    expect(useTabs.getState().active).toBe('t1')
  })
})

describe('лента панели', () => {
  it('идущий блок сохраняется законченным «прервано», без вывода; длинный вывод не сохраняется', () => {
    useTabs.setState({ tabs: [tab('t', ['a'])], active: 't' })
    const big = 'x'.repeat(1024 * 1024 + 1)
    const items = [block('sh-1', 1, { html: big, lines: 9 }), block('sh-2', Date.now() - 1000, { running: true, html: null, exitCode: null, durationMs: null })]
    setPaneFeed('a', () => ({ items, claudeFrom: 0, claudeMode: true }))
    const feed = snapshot().panes.a.feed as ShellBlock[]
    expect(feed[0]).toMatchObject({ html: null, lines: 0 })
    expect(feed[1]).toMatchObject({ running: false, interrupted: true, exitCode: null, html: null })
    expect(feed[1].durationMs).toBeGreaterThanOrEqual(1000)
    expect(snapshot().panes.a.claudeMode).toBe(true)
  })

  it('восстановленная лента: блоки и карточки Claude по местам, режим Claude и ⌃L-граница', () => {
    const state = { ...initialClaude(), sessionId: 's1', items: [{ type: 'user' as const, text: 'привет' }, { type: 'assistant' as const, agentId: 'main', text: 'ок', streaming: true }] }
    applySession({
      version: SESSION_VERSION,
      tabs: [tab('t', ['a'])],
      active: 't',
      panes: {
        a: {
          feed: [block('sh-1', 1), { kind: 'claude', id: 'cl-0' }, { kind: 'claude', id: 'cl-1' }, { kind: 'claude', id: 'cl-7' }],
          claudeFrom: 0,
          claudeMode: true,
          claude: { cwd: '/w', model: null, effort: null, closed: false, queue: [], state },
        },
      },
    })
    const r = restoredPane('a')!
    expect(r.claudeMode).toBe(true)
    expect(r.items.map((x) => x.id)).toEqual(['sh-1', 'cl-0', 'cl-1'])
    // Недописанный ответ — дописан.
    expect(r.items[2]).toMatchObject({ kind: 'claude', item: { type: 'assistant', streaming: false } })
  })

  it('больше предела — выбрасываются самые старые блоки по всем панелям', () => {
    const html = 'y'.repeat(1000)
    const s = {
      version: SESSION_VERSION,
      tabs: [tab('t', ['a', 'b'])],
      active: 't',
      panes: {
        a: { feed: [block('a1', 1, { html }), block('a3', 3, { html })], claudeFrom: 0, claudeMode: false },
        b: { feed: [block('b2', 2, { html }), block('b4', 4, { html })], claudeFrom: 0, claudeMode: false },
      },
    }
    const full = JSON.stringify(s).length
    const out = JSON.parse(serializeCapped(s, full - 500))
    expect(out.panes.a.feed.map((x: ShellBlock) => x.id)).toEqual(['a3'])
    expect(out.panes.b.feed.map((x: ShellBlock) => x.id)).toEqual(['b2', 'b4'])
    expect(serializeCapped(s, full)).toBe(JSON.stringify(s))
  })
})

describe('Claude-сессия панели', () => {
  const restore = (queue: unknown[] = []) =>
    applySession({
      version: SESSION_VERSION,
      tabs: [tab('t', ['a'], { a: '/w' })],
      active: 't',
      panes: {
        a: {
          feed: [],
          claudeFrom: 0,
          claudeMode: true,
          claude: { cwd: '/w', model: 'opus', effort: 'high', closed: false, queue, state: { ...initialClaude(), sessionId: 's1', busy: true, pending: 1, items: [] } },
        },
      },
    })

  it('сессия не запускается сама; следующее сообщение — --resume с моделью и заметкой «Разговор восстановлен»', async () => {
    restore()
    const p = useClaudeSessions.getState().sessions.a
    expect(p).toMatchObject({ procId: null, cwd: '/w', model: 'opus', effort: 'high', restored: true })
    expect(p.state.busy).toBe(false)
    expect(calls('claude_start')).toHaveLength(0)
    await askClaude('a', '/w', 'дальше')
    expect(calls('claude_start')[0][1]).toMatchObject({ cwd: '/w', resume: 's1', model: 'opus', effort: 'high' })
    const items = useClaudeSessions.getState().sessions.a.state.items
    expect(items[0]).toEqual({ type: 'note', text: `${RESTORED_NOTE} · /w` })
    expect(items[1]).toMatchObject({ type: 'user', text: 'дальше' })
    stopClaude('a')
  })

  it('панель в другом каталоге — новая сессия без --resume и без заметки', async () => {
    restore()
    await askClaude('a', '/other', 'вопрос')
    expect(calls('claude_start')[0][1]).toMatchObject({ cwd: '/other', resume: null })
    expect(useClaudeSessions.getState().sessions.a.state.items.some((x) => x.type === 'note')).toBe(false)
    stopClaude('a')
  })

  it('очередь восстанавливается на паузе (не уходит сама)', async () => {
    restore([{ id: 5, text: 'потом' }])
    const p = useClaudeSessions.getState().sessions.a
    expect(p.queue.map((m) => m.text)).toEqual(['потом'])
    expect(p.paused).toBe(true)
    await flush()
    expect(calls('claude_send')).toHaveLength(0)
    stopClaude('a')
  })

  it('снимок сохраняет id сессии, каталог, модель, усилие и очередь', () => {
    restore([{ id: 5, text: 'потом' }])
    const c = snapshot().panes.a.claude!
    expect(c).toMatchObject({ cwd: '/w', model: 'opus', effort: 'high', closed: false })
    expect(c.state.sessionId).toBe('s1')
    expect(c.queue.map((m) => m.text)).toEqual(['потом'])
  })
})

describe('загрузка и запись', () => {
  it('restoreSession читает session_load, изменения пишутся session_save с задержкой', async () => {
    vi.useFakeTimers()
    try {
      invoke.mockImplementation((cmd: string) =>
        Promise.resolve(cmd === 'session_load' ? { version: SESSION_VERSION, tabs: [tab('t9', ['p9'], { p9: '/r' })], active: 't9', panes: {} } : undefined),
      )
      await restoreSession()
      expect(useTabs.getState().tabs[0].cwd).toEqual({ p9: '/r' })
      useTabs.getState().setCwd('p9', '/r2')
      expect(calls('session_save')).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(1100)
      expect(calls('session_save')).toHaveLength(1)
      expect(JSON.parse(calls('session_save')[0][1].text).tabs[0].cwd).toEqual({ p9: '/r2' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('finalSave пишет и выключает автосохранение', async () => {
    vi.useFakeTimers()
    try {
      invoke.mockImplementation(() => Promise.resolve(undefined))
      await restoreSession()
      await finalSave()
      expect(calls('session_save')).toHaveLength(1)
      useTabs.getState().newTab('/z')
      await vi.advanceTimersByTimeAsync(1100)
      expect(calls('session_save')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('saveNow пишет сразу', async () => {
    useTabs.setState({ tabs: [tab('t', ['a'])], active: 't' })
    await saveNow()
    expect(calls('session_save')).toHaveLength(1)
  })
})

describe('карточки правок и планов в файле сессии', () => {
  it('исходный файл правки (diff.original) не сохраняется — и в «Прежнем варианте» тоже', () => {
    const action = {
      type: 'action' as const, agentId: 'main', toolUseId: 'e1', tool: 'Edit', title: 'Изменил файл', detail: '', status: 'done' as const,
      diff: { path: '/w/a.ts', before: 'a', after: 'b', original: 'x\n'.repeat(1000), hunks: [{ oldStart: 1, newStart: 1, lines: ['-a', '+b'] }] },
    }
    const state = { ...initialClaude(), items: [action, { type: 'replaced' as const, count: 1, items: [action] }] }
    useTabs.setState({ tabs: [tab('t', ['a'])], active: 't' })
    useClaudeSessions.setState({ sessions: { a: { state, procId: null, cwd: '/w', model: null, effort: null, permissionMode: null, queue: [], paused: false, pauseHint: false } } })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items = snapshot().panes.a.claude!.state.items as any[]
    expect(items[0].diff).toEqual({ path: '/w/a.ts', before: '', after: '', hunks: [{ oldStart: 1, newStart: 1, lines: ['-a', '+b'] }] })
    expect(items[1].items[0].diff.original).toBeUndefined()
    // Состояние в памяти не тронуто.
    const mem = useClaudeSessions.getState().sessions.a.state.items[0]
    expect(mem.type === 'action' && mem.diff?.original).toBeTruthy()
  })

  it('Write многомегабайтного файла: в файл сессии — только первые строки, с пометкой truncated', () => {
    const big = 'строка текста\n'.repeat(300_000)
    const action = {
      type: 'action' as const, agentId: 'main', toolUseId: 'w1', tool: 'Write', title: 'Изменил файл', detail: '', status: 'done' as const,
      diff: { path: '/w/big.txt', before: '', after: big, created: true },
    }
    useTabs.setState({ tabs: [tab('t', ['a'])], active: 't' })
    useClaudeSessions.setState({ sessions: { a: { state: { ...initialClaude(), items: [action] }, procId: null, cwd: '/w', model: null, effort: null, permissionMode: null, queue: [], paused: false, pauseHint: false } } })
    const json = serializeCapped(snapshot())
    expect(json.length).toBeLessThan(20_000)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const diff = (JSON.parse(json).panes.a.claude.state.items[0] as any).diff
    expect(diff).toMatchObject({ truncated: true, stat: { add: 300_000, del: 0 } })
  })

  it('восстановление: испорченный план — на его месте пусто, целый — как был', () => {
    const good = { type: 'todo', agentId: 'main', toolUseId: 't1', todos: [{ content: 'A', status: 'completed' }] }
    const bad = [
      { type: 'todo', agentId: 'main', toolUseId: 't2', todos: 'x' },
      { type: 'todo', agentId: 'main', toolUseId: 't3', todos: [{ content: 'A', status: 'done' }] },
      { type: 'todo', agentId: 'main', toolUseId: 't4', todos: [null] },
      { type: 'todo', toolUseId: 't5', todos: [] },
    ]
    applySession({
      version: SESSION_VERSION,
      tabs: [tab('t', ['a'], { a: '/w' })],
      active: 't',
      panes: { a: { feed: [], claudeFrom: 0, claudeMode: true, claude: { cwd: '/w', model: null, effort: null, closed: false, queue: [], state: { ...initialClaude(), items: [good, ...bad] } } } },
    })
    const items = useClaudeSessions.getState().sessions.a.state.items
    expect(items[0]).toEqual(good)
    expect(items.slice(1)).toEqual([{ type: 'gone' }, { type: 'gone' }, { type: 'gone' }, { type: 'gone' }])
  })
})
