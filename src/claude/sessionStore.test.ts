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

const { askClaude, claudeCwdKnown, enterClaude, stopClaude, useClaudeSessions, NO_CWD } = await import('./sessionStore')

const items = (pane: string) => useClaudeSessions.getState().sessions[pane]?.state.items ?? []
const calls = (cmd: string) => invoke.mock.calls.filter((c) => c[0] === cmd)
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('enterClaude (команда `claude` в строке ввода)', () => {
  beforeEach(() => {
    stopClaude('p')
    invoke.mockReset()
    invoke.mockImplementation((cmd: string) => Promise.resolve(cmd === 'claude_start' ? 'proc-1' : undefined))
  })

  it('запускает сессию в каталоге панели и пишет строку с подсказкой; вопросов не шлёт', async () => {
    expect(enterClaude('p', '/w')).toBe(true)
    await flush()
    expect(claudeCwdKnown('p', undefined)).toBe(true)
    expect(calls('claude_start')).toHaveLength(1)
    expect(calls('claude_start')[0][1]).toMatchObject({ cwd: '/w', resume: null })
    expect(calls('claude_send')).toHaveLength(0)
    expect(items('p')).toEqual([{ type: 'session', cwd: '/w', mode: true }])
  })

  it('уже идущая сессия не перезапускается; вопрос потом идёт в неё же через claude_send', async () => {
    enterClaude('p', '/w')
    enterClaude('p', '/w')
    await flush()
    expect(calls('claude_start')).toHaveLength(1)
    await askClaude('p', '/w', 'привет')
    expect(calls('claude_start')).toHaveLength(1)
    expect(calls('claude_send')).toEqual([['claude_send', { id: 'proc-1', text: 'привет' }]])
    // Строка новой сессии второй раз не добавляется.
    expect(items('p').filter((i) => i.type === 'session' && !i.mode)).toHaveLength(0)
  })

  it('каталог неизвестен — карточка ошибки, процесс не запускается', () => {
    expect(claudeCwdKnown('p', undefined)).toBe(false)
    expect(enterClaude('p', undefined)).toBe(false)
    expect(calls('claude_start')).toHaveLength(0)
    expect(items('p')).toEqual([{ type: 'error', text: NO_CWD }])
  })
})
