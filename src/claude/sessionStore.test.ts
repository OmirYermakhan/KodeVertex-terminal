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

const { answerQuestion, submitQuestion, askClaude, chooseModel, claudeCwdKnown, enterClaude, stopClaude, useClaudeSessions, NO_CWD } = await import('./sessionStore')

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

describe('chooseModel (/model)', () => {
  /** Отвечает на управляющие запросы как claude: строкой control_response в onLine. */
  let onLine: { onmessage(m: string): void } | null
  let saveError: string | null
  const requests = () => calls('claude_control').map((c) => (c[1] as { request: object }).request)

  beforeEach(() => {
    stopClaude('m')
    invoke.mockReset()
    onLine = null
    saveError = null
    invoke.mockImplementation((cmd: string, a: Record<string, unknown>) => {
      if (cmd === 'claude_start') {
        onLine = a.onLine as typeof onLine
        return Promise.resolve('proc-m')
      }
      if (cmd === 'claude_control') {
        const req = a.request as { subtype: string; model?: string }
        const body =
          req.subtype === 'set_model'
            ? { model: req.model === 'fable' ? 'claude-fable-5-2' : 'claude-opus-5-5' }
            : req.subtype === 'get_settings'
              ? { effective: { model: 'opus' }, applied: { model: 'claude-fable-5-2', effort: 'high' } }
              : undefined
        setTimeout(() =>
          onLine?.onmessage(
            JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: a.requestId, response: body } }),
          ),
        )
        return Promise.resolve()
      }
      if (cmd === 'claude_save_defaults') return saveError ? Promise.reject(saveError) : Promise.resolve()
      return Promise.resolve()
    })
  })

  const state = () => useClaudeSessions.getState().sessions.m

  it('только сессия (s): set_model и усилие живому процессу, заметка, settings.json не трогается', async () => {
    enterClaude('m', '/w')
    await flush()
    await chooseModel('m', '/w', { alias: 'fable', effort: 'high', persist: false })
    expect(requests()).toContainEqual({ subtype: 'set_model', model: 'fable' })
    expect(requests()).toContainEqual({ subtype: 'apply_flag_settings', settings: { effortLevel: 'high' } })
    expect(calls('claude_start')).toHaveLength(1)
    expect(calls('claude_save_defaults')).toHaveLength(0)
    expect(state().state.model).toBe('claude-fable-5-2')
    expect(state().state.items).toContainEqual({ type: 'note', text: 'Модель: Fable 5.2 · усилие high' })
    expect(state()).toMatchObject({ model: 'fable', effort: 'high' })
  })

  it('↵: сохраняет по умолчанию; Default — без модели; усилие не меняли — не пишется', async () => {
    enterClaude('m', '/w')
    await flush()
    await chooseModel('m', '/w', { alias: 'fable', effort: 'max', persist: true })
    expect(calls('claude_save_defaults')[0][1]).toEqual({ model: 'fable', modelId: 'claude-fable-5-2', effort: 'max' })
    await chooseModel('m', '/w', { alias: 'default', effort: null, persist: true })
    expect(calls('claude_save_defaults')[1][1]).toEqual({ model: null, modelId: 'claude-opus-5-5', effort: null })
    expect(requests()).toContainEqual({ subtype: 'set_model', model: 'default' })
  })

  it('ошибка записи настроек — карточка ошибки', async () => {
    saveError = 'файл настроек Claude Code — неверный JSON'
    enterClaude('m', '/w')
    await flush()
    await chooseModel('m', '/w', { alias: 'haiku', effort: null, persist: true })
    expect(state().state.items.at(-1)).toEqual({ type: 'error', text: `Модель не сохранена по умолчанию: ${saveError}` })
  })

  it('после выбора процесс перезапускается с --model/--effort', async () => {
    await chooseModel('m', '/w', { alias: 'sonnet', effort: 'low', persist: false })
    expect(calls('claude_start')[0][1]).toMatchObject({ model: 'sonnet', effort: 'low' })
  })
})

describe('вопросы агента', () => {
  let onLine: { onmessage(m: string): void } | null
  beforeEach(() => {
    stopClaude('q')
    invoke.mockReset()
    onLine = null
    invoke.mockImplementation((cmd: string, a: Record<string, unknown>) => {
      if (cmd === 'claude_start') onLine = a.onLine as typeof onLine
      return Promise.resolve(cmd === 'claude_start' ? 'proc-q' : undefined)
    })
  })
  const input = {
    questions: [
      { question: 'Цвет?', header: 'Цвет', multiSelect: false, options: [{ label: 'Red', description: '' }] },
      { question: 'Размер?', header: 'Размер', multiSelect: true, options: [{ label: 'S', description: '' }, { label: 'M', description: '' }] },
    ],
  }
  const line = (tool: string, inp: object) =>
    JSON.stringify({ type: 'control_request', request_id: 'rq', request: { subtype: 'can_use_tool', tool_name: tool, input: inp, tool_use_id: 't' } })

  it('прочий инструмент — разрешается сразу с исходным вводом', async () => {
    enterClaude('q', '/w')
    await flush()
    onLine!.onmessage(line('Bash', { command: 'ls' }))
    expect(calls('claude_respond')).toEqual([
      ['claude_respond', { id: 'proc-q', requestId: 'rq', response: { behavior: 'allow', updatedInput: { command: 'ls' } } }],
    ])
  })

  it('вопрос ждёт; ответы по шагам уходят одним control_response', async () => {
    enterClaude('q', '/w')
    await flush()
    onLine!.onmessage(line('AskUserQuestion', input))
    expect(calls('claude_respond')).toHaveLength(0)
    expect(items('q').some((i) => i.type === 'question')).toBe(true)
    await answerQuestion('q', 'rq', 0, 'Red')
    await answerQuestion('q', 'rq', 1, 'S, M')
    // Несколько вопросов — ждём «Отправить ответы».
    expect(calls('claude_respond')).toHaveLength(0)
    await submitQuestion('q', 'rq')
    expect(calls('claude_respond')).toEqual([
      [
        'claude_respond',
        {
          id: 'proc-q',
          requestId: 'rq',
          response: { behavior: 'allow', updatedInput: { ...input, answers: { 'Цвет?': 'Red', 'Размер?': 'S, M' } } },
        },
      ],
    ])
  })
})

describe('один вопрос', () => {
  it('ответ уходит сразу', async () => {
    stopClaude('q1')
    invoke.mockReset()
    let onLine: { onmessage(m: string): void } | null = null
    invoke.mockImplementation((cmd: string, a: Record<string, unknown>) => {
      if (cmd === 'claude_start') onLine = a.onLine as typeof onLine
      return Promise.resolve(cmd === 'claude_start' ? 'p1' : undefined)
    })
    enterClaude('q1', '/w')
    await flush()
    const input = { questions: [{ question: 'Да?', header: '', multiSelect: false, options: [{ label: 'Да', description: '' }] }] }
    onLine!.onmessage(JSON.stringify({ type: 'control_request', request_id: 'r', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input } }))
    await answerQuestion('q1', 'r', 0, 'Да')
    expect(calls('claude_respond')[0][1]).toEqual({ id: 'p1', requestId: 'r', response: { behavior: 'allow', updatedInput: { ...input, answers: { 'Да?': 'Да' } } } })
  })
})
