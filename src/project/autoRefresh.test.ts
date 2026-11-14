import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))

const { installAutoRefresh } = await import('./autoRefresh')
const { emitClaudeEvent } = await import('../claude/toolEvents')
const { useProject } = await import('./store')

const statusCalls = () => invoke.mock.calls.filter((c) => c[0] === 'git_status').length

describe('installAutoRefresh', () => {
  let off: () => void
  const refresh = vi.fn()
  beforeEach(() => {
    refresh.mockClear()
    useProject.setState({ root: '/r', claudeTouched: new Set(), refresh })
    off = installAutoRefresh()
  })
  afterEach(() => off())

  it('действие Claude Edit закончилось → refresh и файл помечен «Claude менял»', () => {
    emitClaudeEvent({ kind: 'tools', tools: [{ tool: 'Edit', path: '/r/src/a.ts', ok: true }] })
    expect(refresh).toHaveBeenCalledTimes(1)
    expect([...useProject.getState().claudeTouched]).toEqual(['src/a.ts'])
  })

  it('Bash и неудачная правка → refresh без пометки', () => {
    emitClaudeEvent({ kind: 'tools', tools: [{ tool: 'Bash', path: null, ok: true }, { tool: 'Edit', path: '/r/b.ts', ok: false }] })
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(useProject.getState().claudeTouched.size).toBe(0)
  })

  it('новая сессия Claude (/clear) сбрасывает «Claude менял»', () => {
    useProject.setState({ claudeTouched: new Set(['a.ts']) })
    emitClaudeEvent({ kind: 'cleared' })
    expect(useProject.getState().claudeTouched.size).toBe(0)
  })

  it('фокус окна → refresh; после отписки — нет', () => {
    window.dispatchEvent(new Event('focus'))
    expect(refresh).toHaveBeenCalledTimes(1)
    off()
    window.dispatchEvent(new Event('focus'))
    emitClaudeEvent({ kind: 'tools', tools: [{ tool: 'Bash', path: null, ok: true }] })
    expect(refresh).toHaveBeenCalledTimes(1)
    off = () => {}
  })
})

describe('троттлинг источников вместе', () => {
  let off: () => void
  beforeEach(() => {
    vi.useFakeTimers()
    vi.advanceTimersByTime(1000)
    invoke.mockReset()
    invoke.mockResolvedValue({ changes: [], moreUntracked: 0 })
    // Настоящий refresh стора (первый describe подменял его).
    useProject.setState({ root: '/r', refresh: useProject.getInitialState().refresh })
    off = installAutoRefresh()
  })
  afterEach(() => {
    off()
    vi.useRealTimers()
  })

  it('Claude + фокус + ещё правка подряд — один запрос сразу и один через 500 мс', async () => {
    const { REFRESH_THROTTLE_MS } = await import('./store')
    emitClaudeEvent({ kind: 'tools', tools: [{ tool: 'Bash', path: null, ok: true }] })
    window.dispatchEvent(new Event('focus'))
    emitClaudeEvent({ kind: 'tools', tools: [{ tool: 'Edit', path: '/r/a.ts', ok: true }] })
    expect(statusCalls()).toBe(1)
    // Async: ответ первого запроса успевает прийти (пока он идёт, новый не запускается).
    await vi.advanceTimersByTimeAsync(REFRESH_THROTTLE_MS)
    expect(statusCalls()).toBe(2)
    await vi.advanceTimersByTimeAsync(2000)
    expect(statusCalls()).toBe(2)
  })
})
