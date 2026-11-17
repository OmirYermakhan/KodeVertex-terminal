// Фоновые агенты в сторе сессий: таймаут «главный висит», ⌃C → stop_task, выход процесса, /clear, /exit.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

const { askClaude, clearClaude, enterClaude, exitClaude, interruptClaude, stopClaude, useClaudeSessions } = await import('./sessionStore')
const { MAIN_IDLE_MS } = await import('./reducer')
const { sessionStatus } = await import('../ui/tabStatus')

const calls = (cmd: string) => invoke.mock.calls.filter((c) => c[0] === cmd)
const flush = () => new Promise((r) => setTimeout(r, 0))
const st = () => useClaudeSessions.getState().sessions.p?.state
const agent = (id: string) => st()!.agents.find((a) => a.id === id)!
const ev = (o: object) => JSON.stringify(o)

const agentUse = (id: string) =>
  ev({ type: 'assistant', parent_tool_use_id: null, message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name: 'Agent', input: { description: id, prompt: 'p', run_in_background: true } }] } })
const started = (id: string) => ev({ type: 'system', subtype: 'task_started', task_id: `t-${id}`, tool_use_id: id, is_backgrounded: true })
const launched = (id: string) =>
  ev({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'Async agent launched' }] }, tool_use_result: { status: 'async_launched' } })
const result = ev({ type: 'result', subtype: 'success', is_error: false, result: '', duration_ms: 1, total_cost_usd: 0 })
const notice = (id: string) => ev({ type: 'system', subtype: 'task_notification', task_id: `t-${id}`, tool_use_id: id, status: 'completed' })

let line: (l: string) => void
let exit: (e: { code: number | null; stderr: string }) => void

/** Сессия панели p: ход с двумя фоновыми агентами закончен, главный их ждёт. */
async function waitingForBackground(): Promise<void> {
  enterClaude('p', '/w')
  await flush()
  await askClaude('p', '/w', 'go')
  const args = calls('claude_start').at(-1)![1] as { onLine: { onmessage(m: string): void }; onExit: { onmessage(m: unknown): void } }
  line = (l) => args.onLine.onmessage(l)
  exit = (e) => args.onExit.onmessage(e)
  for (const l of [agentUse('a1'), agentUse('a2'), started('a1'), started('a2'), launched('a1'), launched('a2'), result]) line(l)
  expect(st()).toMatchObject({ busy: false, pending: 0 })
  expect(agent('main')).toMatchObject({ status: 'running', now: 'Ждёт фоновых агентов: 2' })
}

const stopTasks = () =>
  calls('claude_control')
    .map((c) => (c[1] as { request: { subtype: string; task_id?: string } }).request)
    .filter((r) => r.subtype === 'stop_task')

describe('фоновые агенты в сторе', () => {
  beforeEach(() => {
    stopClaude('p')
    invoke.mockReset()
    invoke.mockImplementation((cmd: string) => Promise.resolve(cmd === 'claude_start' ? 'proc-1' : undefined))
  })
  afterEach(() => {
    vi.useRealTimers()
    stopClaude('p')
  })

  it('главный не висит: фоновые закончили, ход CLI не начался — через MAIN_IDLE_MS без событий он готов', async () => {
    await waitingForBackground()
    vi.useFakeTimers()
    line(notice('a1'))
    line(notice('a2'))
    expect(agent('main')).toMatchObject({ status: 'running', now: 'Думает' })
    vi.advanceTimersByTime(MAIN_IDLE_MS - 1000)
    // Любое событие CLI откладывает отсчёт.
    line(ev({ type: 'system', subtype: 'background_tasks_changed', tasks: [] }))
    vi.advanceTimersByTime(MAIN_IDLE_MS - 1000)
    expect(agent('main').status).toBe('running')
    vi.advanceTimersByTime(1000)
    expect(agent('main')).toMatchObject({ status: 'done', now: 'Готово' })
    expect(sessionStatus(st()!)?.status).toBe('done')
  })

  it('пока фоновые работают, таймер не трогает главного', async () => {
    await waitingForBackground()
    vi.useFakeTimers()
    line(notice('a1'))
    vi.advanceTimersByTime(MAIN_IDLE_MS * 3)
    expect(agent('main')).toMatchObject({ status: 'running', now: 'Ждёт фоновых агентов: 1' })
  })

  it('CLI начал свой ход вовремя — таймер не срабатывает', async () => {
    await waitingForBackground()
    vi.useFakeTimers()
    line(notice('a1'))
    line(notice('a2'))
    line(ev({ type: 'system', subtype: 'init', session_id: 's' }))
    vi.advanceTimersByTime(MAIN_IDLE_MS * 2)
    expect(st()).toMatchObject({ busy: true })
    expect(agent('main').status).toBe('running')
    line(result)
    expect(agent('main')).toMatchObject({ status: 'done', now: 'Готово' })
  })

  it('⌃C, пока главный ждёт фоновых: stop_task на каждую задачу, все «Остановлено», interrupt не шлётся', async () => {
    await waitingForBackground()
    expect(interruptClaude('p')).toBe(true)
    expect(stopTasks()).toEqual([
      { subtype: 'stop_task', task_id: 't-a1' },
      { subtype: 'stop_task', task_id: 't-a2' },
    ])
    expect(calls('claude_interrupt')).toHaveLength(0)
    expect(st()!.agents.map((a) => [a.id, a.status, a.now])).toEqual([
      ['main', 'done', 'Остановлено'],
      ['a1', 'done', 'Остановлено'],
      ['a2', 'done', 'Остановлено'],
    ])
    expect(sessionStatus(st()!)?.status).toBe('done')
    // Больше останавливать нечего.
    expect(interruptClaude('p')).toBe(false)
  })

  it('⌃C посреди хода — только interrupt; фоновые работают дальше', async () => {
    enterClaude('p', '/w')
    await flush()
    await askClaude('p', '/w', 'go')
    const args = calls('claude_start')[0][1] as { onLine: { onmessage(m: string): void } }
    for (const l of [agentUse('a1'), started('a1'), launched('a1')]) args.onLine.onmessage(l)
    expect(interruptClaude('p')).toBe(true)
    expect(calls('claude_interrupt')).toHaveLength(1)
    expect(stopTasks()).toEqual([])
    expect(agent('a1').status).toBe('running')
  })

  it('выход процесса, пока главный ждёт фоновых: никто не остаётся «работает»', async () => {
    await waitingForBackground()
    exit({ code: 0, stderr: '' })
    expect(st()!.agents.every((a) => a.status === 'done' && a.now === 'Остановлено')).toBe(true)
    expect(sessionStatus(st()!)?.status).toBe('done')
  })

  it('выход процесса с ошибкой — агенты «Ошибка»', async () => {
    await waitingForBackground()
    exit({ code: 1, stderr: 'boom' })
    expect(st()!.agents.every((a) => a.status === 'error')).toBe(true)
  })

  it('/clear и /exit: агенты как у новой сессии, таймер главного снят', async () => {
    await waitingForBackground()
    vi.useFakeTimers()
    line(notice('a1'))
    line(notice('a2'))
    clearClaude('p')
    expect(st()!.agents.map((a) => [a.id, a.status])).toEqual([['main', 'waiting']])
    expect(sessionStatus(st()!)).toBeNull()
    vi.advanceTimersByTime(MAIN_IDLE_MS * 2)
    expect(agent('main').status).toBe('waiting')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('/exit и закрытие панели при ждущем главном — таймеров не остаётся, сессия не воскресает', async () => {
    await waitingForBackground()
    vi.useFakeTimers()
    line(notice('a1'))
    line(notice('a2'))
    exitClaude('p')
    expect(useClaudeSessions.getState().sessions.p.closed).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
    stopClaude('p')
    await waitingForBackground()
    vi.useFakeTimers()
    line(notice('a1'))
    line(notice('a2'))
    stopClaude('p')
    vi.advanceTimersByTime(MAIN_IDLE_MS * 2)
    expect(useClaudeSessions.getState().sessions.p).toBeUndefined()
  })
})
