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
const win = vi.hoisted(() => ({
  label: 'main',
  close: vi.fn(() => Promise.resolve()),
  listeners: new Map<string, (e: { payload: unknown }) => void>(),
}))
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    label: win.label,
    close: win.close,
    listen: (ev: string, f: (e: { payload: unknown }) => void) => {
      win.listeners.set(ev, f)
      return Promise.resolve(() => {})
    },
  }),
}))

const { adoptTab, bootWindow, canMoveToNewWindow, detachTab, isTransferring, moveTabToNewWindow, moveTabToWindow, RECEIVE_EVENT } = await import('./transfer')
const { isMoving, liveSource, resetLivePanesForTests, setLiveSource, takeLive } = await import('./livePanes')
const { useTabs } = await import('../layout/tabsStore')
const { leaf } = await import('../layout/paneTree')
const { DETACH_LAUNCH_WAIT_MS, enterClaude, resetTrustForTests, stopClaude, useClaudeSessions, useClaudeTrust } = await import('../claude/sessionStore')
const { resetPersistForTests, restoredPane, setPaneFeed, SESSION_VERSION } = await import('../persist/session')
const { initialClaude } = await import('../claude/reducer')

const flush = () => new Promise((r) => setTimeout(r, 0))
const calls = (cmd: string) => invoke.mock.calls.filter((c) => c[0] === cmd)
const tab = (id: string, pane = id) => ({ id, tree: leaf(pane), focused: pane, cwd: { [pane]: '/w' } })

const runningBlock = {
  kind: 'shell' as const,
  id: 'sh-1',
  command: 'ping x',
  cwd: '/w',
  startedAt: 1,
  durationMs: null,
  exitCode: null,
  html: null,
  lines: 0,
  running: true,
  live: true as const,
}
const live = {
  ptyId: 'pty-a',
  mark: 'm',
  localHost: null,
  cwd: '/w',
  running: true,
  raw: false,
  rawCommand: '',
  promptSeen: true,
  alt: false,
  altUsed: false,
  cont: false,
  sent: null,
  accepted: null,
  echoRow: null,
  cols: 80,
  rows: 24,
  xterm: 'SCREEN',
}

function backend(over: Record<string, unknown> = {}) {
  invoke.mockImplementation((cmd: string) => {
    if (cmd in over) {
      const v = over[cmd]
      return v instanceof Error ? Promise.reject(v) : Promise.resolve(v)
    }
    if (cmd === 'claude_start') return Promise.resolve('proc-a')
    if (cmd === 'claude_trust_check') return Promise.resolve(true)
    if (cmd === 'window_open') return Promise.resolve('w-1')
    if (cmd === 'window_count') return Promise.resolve(1)
    return Promise.resolve(null)
  })
}

/** Панель 'a' вкладки t1: идущий блок в ленте, живой PTY, процесс Claude. */
async function livePaneA() {
  setPaneFeed('a', () => ({ items: [runningBlock], claudeFrom: 0, claudeMode: true }))
  setLiveSource('a', { ptyId: () => 'pty-a', capture: () => Promise.resolve(live) })
  enterClaude('a', '/w')
  await flush()
  await flush()
  expect(useClaudeSessions.getState().sessions.a.procId).toBe('proc-a')
}

beforeEach(() => {
  for (const id of Object.keys(useClaudeSessions.getState().sessions)) stopClaude(id)
  resetLivePanesForTests()
  resetPersistForTests()
  resetTrustForTests()
  invoke.mockReset()
  backend()
  win.label = 'main'
  win.close.mockClear()
  win.listeners.clear()
  useTabs.setState({ tabs: [tab('t1', 'a'), tab('t2', 'b')], active: 't1', respawns: [] })
})

describe('detachTab', () => {
  it('отсоединяет PTY и claude, снимает ленту как есть, убирает вкладку без новой', async () => {
    await livePaneA()
    const t = await detachTab('t1')
    expect(calls('pty_detach')).toEqual([['pty_detach', { id: 'pty-a' }]])
    expect(calls('claude_detach')).toEqual([['claude_detach', { id: 'proc-a' }]])
    expect(t.tab.id).toBe('t1')
    const p = t.panes.a
    expect(p.live).toEqual(live)
    expect(p.claudeProcId).toBe('proc-a')
    expect(p.claude?.procId).toBe('proc-a')
    // Идущий блок не стал «прервано».
    expect(p.saved.feed).toEqual([runningBlock])
    expect(p.saved.claudeMode).toBe(true)
    expect(useTabs.getState().tabs.map((x) => x.id)).toEqual(['t2'])
    expect(useTabs.getState().active).toBe('t2')
    expect(isMoving('a')).toBe(true)
    // Размонтирование уезжающей панели не останавливает claude.
    stopClaude('a')
    expect(calls('claude_stop')).toHaveLength(0)
  })

  it('последняя вкладка: вкладок не остаётся (новая не создаётся)', async () => {
    useTabs.setState({ tabs: [tab('t1', 'a')], active: 't1', respawns: [] })
    await detachTab('t1')
    expect(useTabs.getState().tabs).toEqual([])
  })

  it('запуск claude ещё идёт — сначала дождаться его', async () => {
    let started!: (id: string) => void
    backend({})
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'claude_start') return new Promise((r) => (started = r))
      if (cmd === 'claude_trust_check') return Promise.resolve(true)
      return Promise.resolve(null)
    })
    enterClaude('a', '/w')
    await flush()
    const d = detachTab('t1')
    await flush()
    expect(calls('claude_detach')).toHaveLength(0)
    started('proc-late')
    const t = await d
    expect(calls('claude_detach')).toEqual([['claude_detach', { id: 'proc-late' }]])
    expect(t.panes.a.claudeProcId).toBe('proc-late')
  })

  it('pty_detach не удался — оболочка убита, живого PTY в переносе нет', async () => {
    backend({ pty_detach: new Error('old build') })
    setLiveSource('a', { ptyId: () => 'pty-a', capture: () => Promise.resolve(live) })
    const t = await detachTab('t1')
    await flush()
    expect(t.panes.a.live).toBeUndefined()
    expect(calls('pty_kill')).toEqual([['pty_kill', { id: 'pty-a' }]])
  })
})

describe('adoptTab', () => {
  it('вкладка — в конец и активная; лента, живой PTY и сессия Claude ждут панель; claude_attach с новыми каналами', async () => {
    await livePaneA()
    const t = await detachTab('t1')
    // Приёмник — «другое окно»: сторы этой вкладки пусты.
    stopClaude('a')
    invoke.mockClear()
    adoptTab(t)
    expect(useTabs.getState().tabs.map((x) => x.id)).toEqual(['t2', 't1'])
    expect(useTabs.getState().active).toBe('t1')
    expect(isMoving('a')).toBe(false)
    expect(restoredPane('a')?.items).toEqual([runningBlock])
    expect(takeLive('a')).toEqual(live)
    const s = useClaudeSessions.getState().sessions.a
    expect(s.procId).toBe('proc-a')
    const [, args] = calls('claude_attach')[0] as [string, { id: string; onLine: { onmessage: (m: unknown) => void }; onExit: { onmessage: (m: unknown) => void } }]
    expect(args.id).toBe('proc-a')
    expect(calls('claude_start')).toHaveLength(0)
    // Выход процесса приходит в новые обработчики.
    args.onExit.onmessage({ code: 0, stderr: '' })
    expect(useClaudeSessions.getState().sessions.a.procId).toBeNull()
  })

  it('без живой сессии — Claude из saved, как после перезапуска (без процесса)', () => {
    const state = { ...initialClaude(), sessionId: 'S1', items: [{ type: 'user' as const, text: 'hi', at: 1 }] }
    adoptTab({
      tab: tab('t3', 'c'),
      panes: {
        c: {
          saved: {
            feed: [{ kind: 'claude', id: 'cl-0' }],
            claudeFrom: 0,
            claudeMode: false,
            claude: { cwd: '/w', model: null, effort: null, closed: false, queue: [{ id: 5, text: 'q' }], state },
          },
        },
      },
    })
    const s = useClaudeSessions.getState().sessions.c
    expect(s.procId).toBeNull()
    expect(s.state.sessionId).toBe('S1')
    expect(s.queue.map((m) => m.text)).toEqual(['q'])
    expect(calls('claude_attach')).toHaveLength(0)
  })

  it('claude_attach не удался — процесса нет, карточка ошибки', async () => {
    backend({ claude_attach: new Error('нет процесса') })
    adoptTab({
      tab: tab('t3', 'c'),
      panes: { c: { saved: { feed: [], claudeFrom: 0, claudeMode: true }, claudeProcId: 'p9', claude: { state: initialClaude(), procId: 'p9', cwd: '/w', model: null, effort: null, permissionMode: null, queue: [], paused: false, pauseHint: false } } },
    })
    await flush()
    const s = useClaudeSessions.getState().sessions.c
    expect(s.procId).toBeNull()
    expect(s.state.items.at(-1)).toMatchObject({ type: 'error' })
  })
})

describe('moveTabToNewWindow / moveTabToWindow', () => {
  it('новое окно: window_open с переносом и курсором; окно-источник с вкладками не закрывается', async () => {
    expect(await moveTabToNewWindow('t1', 500, 300)).toBe(true)
    const [, args] = calls('window_open')[0] as [string, { payload: { kind: string; tab: { tab: { id: string } } }; x: number; y: number }]
    expect(args.x).toBe(500)
    expect(args.y).toBe(300)
    expect(args.payload.kind).toBe('transfer')
    expect(args.payload.tab.tab.id).toBe('t1')
    expect(win.close).not.toHaveBeenCalled()
  })

  it('единственную вкладку единственного окна вынести нельзя', async () => {
    useTabs.setState({ tabs: [tab('t1', 'a')], active: 't1', respawns: [] })
    expect(await canMoveToNewWindow()).toBe(false)
    expect(await moveTabToNewWindow('t1', 0, 0)).toBe(false)
    expect(useTabs.getState().tabs).toHaveLength(1)
    expect(calls('window_open')).toHaveLength(0)
  })

  it('последняя вкладка уехала (окон несколько) — окно закрывается', async () => {
    backend({ window_count: 2 })
    useTabs.setState({ tabs: [tab('t1', 'a')], active: 't1', respawns: [] })
    expect(await moveTabToNewWindow('t1', 0, 0)).toBe(true)
    expect(win.close).toHaveBeenCalledTimes(1)
  })

  it('в другое окно: window_send_tab; последняя вкладка — окно закрывается', async () => {
    useTabs.setState({ tabs: [tab('t1', 'a')], active: 't1', respawns: [] })
    expect(await moveTabToWindow('t1', 'w-2')).toBe(true)
    const [, args] = calls('window_send_tab')[0] as [string, { target: string; payload: { kind: string } }]
    expect(args.target).toBe('w-2')
    expect(args.payload.kind).toBe('transfer')
    expect(win.close).toHaveBeenCalledTimes(1)
  })

  it('приёмник не принял — вкладка возвращается и снова активна, окно не закрывается', async () => {
    backend({ window_send_tab: new Error('нет окна') })
    setLiveSource('a', { ptyId: () => 'pty-a', capture: () => Promise.resolve(live) })
    const src = liveSource('a')!
    // Панель «размонтирована» (источник снят), как сделал бы React после удаления вкладки.
    const off = useTabs.subscribe((s) => {
      if (!s.tabs.some((t) => t.id === 't1')) {
        resetLivePanesForTests()
        off()
      }
    })
    expect(src).toBeDefined()
    expect(await moveTabToWindow('t1', 'w-2')).toBe(false)
    expect(useTabs.getState().tabs.map((x) => x.id)).toEqual(['t2', 't1'])
    expect(useTabs.getState().active).toBe('t1')
    expect(takeLive('a')).toEqual(live)
    expect(win.close).not.toHaveBeenCalled()
  })

  it('в своё же окно — ничего', async () => {
    expect(await moveTabToWindow('t1', 'main')).toBe(false)
    expect(useTabs.getState().tabs).toHaveLength(2)
  })
})

describe('bootWindow', () => {
  const transfer = (id: string, pane: string) => ({ kind: 'transfer', tab: { tab: tab(id, pane), panes: { [pane]: { saved: { feed: [], claudeFrom: 0, claudeMode: false } } } } })

  it('main — сессия из файла', async () => {
    await bootWindow()
    expect(calls('session_load')).toHaveLength(1)
    expect(calls('window_take_init')).toHaveLength(0)
    expect(win.listeners.has(RECEIVE_EVENT)).toBe(true)
  })

  it('другое окно с переносом — только эта вкладка', async () => {
    win.label = 'w-1'
    backend({ window_take_init: transfer('tx', 'px') })
    await bootWindow()
    expect(calls('session_load')).toHaveLength(0)
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(['tx'])
    expect(useTabs.getState().active).toBe('tx')
  })

  it('другое окно без payload — одна новая вкладка', async () => {
    win.label = 'w-1'
    useTabs.setState({ tabs: [tab('fresh')], active: 'fresh', respawns: [] })
    await bootWindow()
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(['fresh'])
  })

  it('другое окно с restore — его часть сессии', async () => {
    win.label = 'w-1'
    backend({ window_take_init: { kind: 'restore', session: { version: SESSION_VERSION, tabs: [tab('r1'), tab('r2')], active: 'r2', panes: {} } } })
    await bootWindow()
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(['r1', 'r2'])
    expect(useTabs.getState().active).toBe('r2')
  })

  it('tab://receive — вкладка добавляется и активна; повтор того же — без дубля', async () => {
    await bootWindow()
    const f = win.listeners.get(RECEIVE_EVENT)!
    f({ payload: transfer('t9', 'p9') })
    f({ payload: transfer('t9', 'p9') })
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(['t1', 't2', 't9'])
    expect(useTabs.getState().active).toBe('t9')
    // Мусор не принимается.
    f({ payload: { kind: 'transfer' } })
    expect(useTabs.getState().tabs).toHaveLength(3)
  })
})

describe('detachClaude не удался', () => {
  it('процесс останавливается здесь; приёмник получит Claude из saved', async () => {
    await livePaneA()
    backend({ claude_detach: new Error('old build') })
    const t = await detachTab('t1')
    expect(calls('claude_stop')).toEqual([['claude_stop', { id: 'proc-a' }]])
    expect(t.panes.a.claudeProcId).toBeUndefined()
  })
})

type Ch = { onmessage: (m: unknown) => void }
const lineCh = () => (calls('claude_start')[0][1] as { onLine: Ch }).onLine

describe('маркер конца канала при отсоединении', () => {
  it('claude: строка в пути после ответа claude_detach попадает в снимок; маркер не идёт в редьюсер', async () => {
    await livePaneA()
    let answered = false
    backend({})
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'claude_detach') {
        answered = true
        return Promise.resolve(true)
      }
      return Promise.resolve(null)
    })
    const d = detachTab('t1')
    await flush()
    expect(answered).toBe(true)
    // Ответ пришёл раньше длинной строки (её канал Tauri отдаёт отдельным запросом).
    lineCh().onmessage(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'S-late' }))
    lineCh().onmessage('')
    const t = await d
    expect(t.panes.a.claude?.state.sessionId).toBe('S-late')
  })

  it('pty: снимок — после маркера (pty_detach ответил раньше последнего вывода)', async () => {
    const order: string[] = []
    backend({ pty_detach: true })
    // Канал панели a: зарегистрирован через attachPty реального ptyClient.
    const { attachPty } = await import('../terminal/ptyClient')
    await attachPty({ id: 'pty-a', mark: 'm', onData: () => order.push('data'), onExit: () => {} })
    const ch = (calls('pty_attach')[0][1] as { onData: Ch }).onData
    setLiveSource('a', {
      ptyId: () => 'pty-a',
      capture: () => {
        order.push('capture')
        return Promise.resolve(live)
      },
    })
    const d = detachTab('t1')
    await flush()
    expect(order).toEqual([])
    ch.onmessage(new Uint8Array([1]).buffer)
    ch.onmessage(new ArrayBuffer(0))
    const t = await d
    expect(order).toEqual(['data', 'capture'])
    expect(t.panes.a.live).toEqual(live)
  })
})

describe('двойной перенос и откат', () => {
  it('вкладка помечена «переезжает» синхронно: второй перенос той же вкладки — false', async () => {
    const first = moveTabToWindow('t1', 'w-2')
    expect(isTransferring('t1')).toBe(true)
    expect(await moveTabToWindow('t1', 'w-3')).toBe(false)
    expect(await moveTabToNewWindow('t1', 0, 0)).toBe(false)
    expect(await first).toBe(true)
    expect(isTransferring('t1')).toBe(false)
    expect(calls('window_send_tab')).toHaveLength(1)
    expect(calls('window_open')).toHaveLength(0)
  })

  it('вкладку закрыли во время отсоединения — ошибка, ничего не помечено «переезжает»', async () => {
    let release!: () => void
    invoke.mockImplementation((cmd: string) => (cmd === 'pty_detach' ? new Promise<void>((r) => (release = () => r())) : Promise.resolve(null)))
    setLiveSource('a', { ptyId: () => 'pty-a', capture: () => Promise.resolve(live) })
    const d = detachTab('t1')
    await flush()
    useTabs.setState({ tabs: [tab('t2', 'b')], active: 't2', respawns: [] })
    release()
    await expect(d).rejects.toThrow(/закрыта/)
    expect(isMoving('a')).toBe(false)
  })

  it('сбой после отсоединения — PTY и claude подключаются обратно к этому окну', async () => {
    await livePaneA()
    const reattach = vi.fn(() => Promise.resolve())
    setLiveSource('a', { ptyId: () => 'pty-a', capture: () => Promise.reject(new Error('serialize')), reattach })
    invoke.mockClear()
    await expect(detachTab('t1')).rejects.toThrow('serialize')
    expect(reattach).toHaveBeenCalledTimes(1)
    expect(calls('claude_attach').map((c) => (c[1] as { id: string }).id)).toEqual(['proc-a'])
    expect(useTabs.getState().tabs.map((x) => x.id)).toEqual(['t1', 't2'])
    expect(useClaudeSessions.getState().sessions.a.procId).toBe('proc-a')
  })
})

describe('detachClaude не ждёт вечно', () => {
  it('запуск ждёт «Доверять папке?» — не ждать: запуск отменён, процесса в переносе нет', async () => {
    // Проверку доверия обошли, Rust отказал при запуске: запуск ждёт ответа на «Доверять?».
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'claude_trust_check') return Promise.resolve(true)
      if (cmd === 'claude_start') return Promise.reject(new Error('UNTRUSTED_DIR'))
      return Promise.resolve(null)
    })
    enterClaude('a', '/w')
    await flush()
    await flush()
    expect(useClaudeTrust.getState().asks.a).toMatchObject({ cwd: '/w' })
    const t = await detachTab('t1')
    expect(calls('claude_detach')).toHaveLength(0)
    expect(t.panes.a.claudeProcId).toBeUndefined()
    // Вопрос снят, повторного запуска нет.
    expect(useClaudeTrust.getState().asks.a).toBeUndefined()
    await flush()
    expect(calls('claude_start')).toHaveLength(1)
  })

  it('запуск не отвечает — не дольше DETACH_LAUNCH_WAIT_MS', async () => {
    vi.useFakeTimers()
    try {
      let started!: (id: string) => void
      invoke.mockImplementation((cmd: string) => {
        if (cmd === 'claude_start') return new Promise((r) => (started = r))
        if (cmd === 'claude_trust_check') return Promise.resolve(true)
        return Promise.resolve(null)
      })
      enterClaude('a', '/w')
      await vi.advanceTimersByTimeAsync(0)
      const d = detachTab('t1')
      await vi.advanceTimersByTimeAsync(DETACH_LAUNCH_WAIT_MS + 10)
      const t = await d
      expect(t.panes.a.claudeProcId).toBeUndefined()
      // Поздний ответ запуска — процесс останавливается.
      started('proc-late')
      await vi.advanceTimersByTimeAsync(0)
      expect(calls('claude_stop')).toEqual([['claude_stop', { id: 'proc-late' }]])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('adoptClaude без процесса', () => {
  it('ход шёл (или главный ждал фоновых) — остановлен, вкладка не «работает» вечно', () => {
    const base = initialClaude()
    const state = {
      ...base,
      busy: true,
      pending: 1,
      agents: base.agents.map((a) => ({ ...a, status: 'running' as const, startedAt: 1 })),
    }
    adoptTab({
      tab: tab('t3', 'c'),
      panes: { c: { saved: { feed: [], claudeFrom: 0, claudeMode: true }, claude: { state, procId: null, cwd: '/w', model: null, effort: null, permissionMode: null, queue: [], paused: false, pauseHint: false } } },
    })
    const s = useClaudeSessions.getState().sessions.c
    expect(s.state.busy).toBe(false)
    expect(s.state.agents.every((a) => a.status !== 'running')).toBe(true)
  })
})

describe('bootWindow: принятое окно сохраняется сразу', () => {
  it('w-* с переносом — session_save без изменений после запуска', async () => {
    vi.useFakeTimers()
    try {
      win.label = 'w-1'
      backend({ window_take_init: { kind: 'transfer', tab: { tab: tab('tx', 'px'), panes: { px: { saved: { feed: [], claudeFrom: 0, claudeMode: false } } } } } })
      await bootWindow()
      await vi.advanceTimersByTimeAsync(5000)
      expect(calls('session_save').length).toBeGreaterThanOrEqual(1)
      expect(JSON.parse((calls('session_save')[0][1] as { text: string }).text).tabs[0].id).toBe('tx')
    } finally {
      vi.useRealTimers()
    }
  })
})
