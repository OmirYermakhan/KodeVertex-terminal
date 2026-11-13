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

const { claudeOpen, clearClaude, exitClaude, editClaude, recallQueued, removeQueued, sendQueued, dismissQueueHint, answerPermission, answerQuestion, interruptClaude, submitQuestion, askClaude, chooseModel, claudeCwdKnown, enterClaude, stopClaude, useClaudeSessions, NO_CWD } = await import('./sessionStore')

const { useSettings } = await import('../settings/store')

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

  it('режим разрешений — из настроек на момент запуска (по умолчанию acceptEdits) и запоминается у сессии', async () => {
    enterClaude('p', '/w')
    await flush()
    expect(calls('claude_start')[0][1]).toMatchObject({ permissionMode: 'acceptEdits' })
    expect(useClaudeSessions.getState().sessions.p.permissionMode).toBe('acceptEdits')
    stopClaude('p')
    const prev = useSettings.getState().settings
    useSettings.setState({ settings: { ...prev, claudePermissionMode: 'bypassPermissions' } })
    try {
      enterClaude('p', '/w')
      await flush()
      expect(calls('claude_start')[1][1]).toMatchObject({ permissionMode: 'bypassPermissions' })
      expect(useClaudeSessions.getState().sessions.p.permissionMode).toBe('bypassPermissions')
    } finally {
      useSettings.setState({ settings: prev })
    }
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
            ? { model: req.model?.startsWith('fable') ? 'claude-fable-5-2[1m]' : 'claude-opus-5-5[1m]' }
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
    expect(requests()).toContainEqual({ subtype: 'set_model', model: 'fable[1m]' })
    expect(requests()).toContainEqual({ subtype: 'apply_flag_settings', settings: { effortLevel: 'high' } })
    expect(calls('claude_start')).toHaveLength(1)
    expect(calls('claude_save_defaults')).toHaveLength(0)
    expect(state().state.model).toBe('claude-fable-5-2')
    expect(state().state.items).toContainEqual({ type: 'note', text: 'Модель: Fable 5.2 · усилие high' })
    expect(state()).toMatchObject({ model: 'fable[1m]', effort: 'high' })
  })

  it('↵: сохраняет по умолчанию; Default — без модели; усилие не меняли — не пишется', async () => {
    enterClaude('m', '/w')
    await flush()
    await chooseModel('m', '/w', { alias: 'fable', effort: 'max', persist: true })
    expect(calls('claude_save_defaults')[0][1]).toEqual({ model: 'fable[1m]', modelId: 'claude-fable-5-2[1m]', effort: 'max' })
    await chooseModel('m', '/w', { alias: 'default', effort: null, persist: true })
    expect(calls('claude_save_defaults')[1][1]).toEqual({ model: null, modelId: 'claude-opus-5-5[1m]', effort: null })
    expect(requests()).toContainEqual({ subtype: 'set_model', model: 'default' })
  })

  it('ошибка записи настроек — карточка ошибки', async () => {
    saveError = 'файл настроек Claude Code — неверный JSON'
    enterClaude('m', '/w')
    await flush()
    await chooseModel('m', '/w', { alias: 'haiku', effort: null, persist: true })
    expect(state().state.items.at(-1)).toEqual({ type: 'error', text: `Модель не сохранена по умолчанию: ${saveError}` })
  })

  it('модель панели запоминается после set_model; перезапуск — с --model/--effort', async () => {
    await chooseModel('m', '/w', { alias: 'sonnet', effort: 'low', persist: false })
    expect(state()).toMatchObject({ model: 'sonnet[1m]', effort: 'low' })
    const first = calls('claude_start')[0][1] as { onExit: { onmessage(e: unknown): void } }
    first.onExit.onmessage({ code: 0, stderr: '' })
    await askClaude('m', '/w', 'дальше')
    expect(calls('claude_start')[1][1]).toMatchObject({ model: 'sonnet[1m]', effort: 'low' })
  })

  it('set_model не прошёл — модель панели не меняется, карточка ошибки; ответ не ждём 10 с после выхода', async () => {
    enterClaude('m', '/w')
    await flush()
    invoke.mockImplementation((cmd: string) => (cmd === 'claude_control' ? Promise.reject('нет сессии') : Promise.resolve()))
    await chooseModel('m', '/w', { alias: 'haiku', effort: null, persist: true })
    expect(state().model).toBeNull()
    expect(state().state.items.at(-1)).toEqual({ type: 'error', text: 'Не удалось сменить модель: нет сессии' })
    expect(calls('claude_save_defaults')).toHaveLength(0)
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

  it('разрешение ждёт решения: запретить / разрешить / всегда; ввод не объект — запрет сразу', async () => {
    enterClaude('q', '/w')
    await flush()
    const send = (rid: string, inp: unknown, extra = {}) =>
      onLine!.onmessage(JSON.stringify({ type: 'control_request', request_id: rid, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: inp, ...extra } }))
    send('a', { command: 'git push' })
    expect(calls('claude_respond')).toHaveLength(0)
    expect(items('q').at(-1)).toMatchObject({ type: 'permission', requestId: 'a' })
    await answerPermission('q', 'a', 'deny')
    send('b', { command: 'ls' })
    await answerPermission('q', 'b', 'allow')
    const sug = [{ type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'Bash' }] }]
    send('c', { command: 'ls' }, { permission_suggestions: sug })
    await answerPermission('q', 'c', 'always')
    send('d', 'строка')
    expect(calls('claude_respond').map((c) => c[1])).toEqual([
      { id: 'proc-q', requestId: 'a', response: { behavior: 'deny', message: 'Пользователь запретил' } },
      { id: 'proc-q', requestId: 'b', response: { behavior: 'allow', updatedInput: { command: 'ls' } } },
      { id: 'proc-q', requestId: 'c', response: { behavior: 'allow', updatedInput: { command: 'ls' }, updatedPermissions: sug } },
      { id: 'proc-q', requestId: 'd', response: { behavior: 'deny', message: 'Пользователь запретил' } },
    ])
  })

  it('⌃C при ждущем вопросе — вопрос отменён', async () => {
    await askClaude('q', '/w', 'спроси')
    onLine!.onmessage(line('AskUserQuestion', input))
    expect(interruptClaude('q')).toBe(true)
    expect(items('q').find((i) => i.type === 'question')).toMatchObject({ cancelled: 'stop' })
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

describe('выход claude при ждущем вопросе', () => {
  it('вопрос отменяется, агент — ошибка', async () => {
    stopClaude('x')
    invoke.mockReset()
    let ch: { onLine: { onmessage(m: string): void }; onExit: { onmessage(e: unknown): void } } | null = null
    invoke.mockImplementation((cmd: string, a: Record<string, unknown>) => {
      if (cmd === 'claude_start') ch = a as unknown as typeof ch
      return Promise.resolve(cmd === 'claude_start' ? 'px' : undefined)
    })
    await askClaude('x', '/w', 'спроси меня')
    const input = { questions: [{ question: 'Да?', header: '', multiSelect: false, options: [{ label: 'Да', description: '' }] }] }
    ch!.onLine.onmessage(JSON.stringify({ type: 'control_request', request_id: 'r', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input } }))
    const { pendingQuestion } = await import('./reducer')
    expect(pendingQuestion(useClaudeSessions.getState().sessions.x.state)).not.toBeNull()
    ch!.onExit.onmessage({ code: 1, stderr: 'boom' })
    const st = useClaudeSessions.getState().sessions.x.state
    expect(pendingQuestion(st)).toBeNull()
    expect(st.items.find((i) => i.type === 'question')).toMatchObject({ cancelled: 'exit', done: false })
    expect(st.agents[0].status).toBe('error')
  })
})

describe('по умолчанию с [1m]', () => {
  it('Opus и Fable пишутся с [1m] — окно 1 млн токенов', async () => {
    stopClaude('d')
    invoke.mockReset()
    let onLine: { onmessage(m: string): void } | null = null
    invoke.mockImplementation((cmd: string, a: Record<string, unknown>) => {
      if (cmd === 'claude_start') onLine = a.onLine as typeof onLine
      if (cmd === 'claude_control') {
        const req = a.request as { subtype: string }
        const body = req.subtype === 'get_settings' ? { effective: { model: 'opus[1m]' }, applied: { model: 'claude-opus-5-5[1m]', effort: 'medium' } } : { model: 'claude-opus-5-5[1m]' }
        setTimeout(() => onLine?.onmessage(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: a.requestId, response: body } })))
      }
      return Promise.resolve(cmd === 'claude_start' ? 'pd' : undefined)
    })
    enterClaude('d', '/w')
    await flush()
    await flush()
    await chooseModel('d', '/w', { alias: 'opus', effort: null, persist: true })
    expect(calls('claude_save_defaults')[0][1]).toMatchObject({ model: 'opus[1m]' })
    await chooseModel('d', '/w', { alias: 'fable', effort: null, persist: true })
    expect(calls('claude_save_defaults')[1][1]).toMatchObject({ model: 'fable[1m]' })
  })
})

describe('выход процесса и управляющие запросы', () => {
  it('ждущий ответа запрос отклоняется сразу при выходе (без таймаута)', async () => {
    stopClaude('e')
    invoke.mockReset()
    let onExit: { onmessage(e: unknown): void } | null = null
    invoke.mockImplementation((cmd: string, a: Record<string, unknown>) => {
      if (cmd === 'claude_start') onExit = a.onExit as typeof onExit
      return Promise.resolve(cmd === 'claude_start' ? 'pe' : undefined)
    })
    enterClaude('e', '/w')
    await flush()
    const t0 = Date.now()
    const p = chooseModel('e', '/w', { alias: 'opus', effort: null, persist: false })
    await flush()
    onExit!.onmessage({ code: 1, stderr: '' })
    await p
    expect(Date.now() - t0).toBeLessThan(2000)
    const st = useClaudeSessions.getState().sessions.e.state
    expect(st.items.some((i) => i.type === 'error' && i.text === 'Не удалось сменить модель: Claude завершился')).toBe(true)
  })
})

describe('очередь сообщений', () => {
  let ch: { onLine: { onmessage(m: string): void }; onExit: { onmessage(e: unknown): void } } | null = null
  beforeEach(() => {
    stopClaude('u')
    invoke.mockReset()
    ch = null
    invoke.mockImplementation((cmd: string, a: Record<string, unknown>) => {
      if (cmd === 'claude_start') ch = a as unknown as typeof ch
      return Promise.resolve(cmd === 'claude_start' ? 'pu' : undefined)
    })
  })
  const sess = () => useClaudeSessions.getState().sessions.u
  const sent = () => calls('claude_send').map((c) => (c[1] as { text: string }).text)
  const users = () => items('u').filter((i) => i.type === 'user').map((i) => (i as { text: string }).text)
  const result = () => ch!.onLine.onmessage(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', session_id: 's1' }))

  it('пока ход идёт — сообщение в очередь, не в stdin; по result — следующее, по одному за ход', async () => {
    await askClaude('u', '/w', 'первое')
    await askClaude('u', '/w', 'второе')
    await askClaude('u', '/w', 'третье')
    expect(sent()).toEqual(['первое'])
    expect(sess().queue.map((m) => m.text)).toEqual(['второе', 'третье'])
    // Пузырь «Вы» — только в момент отправки.
    expect(users()).toEqual(['первое'])
    result()
    await flush()
    expect(sent()).toEqual(['первое', 'второе'])
    expect(users()).toEqual(['первое', 'второе'])
    expect(items('u').at(-1)).toMatchObject({ type: 'user', text: 'второе' })
    expect(sess().queue.map((m) => m.text)).toEqual(['третье'])
    expect(sess().state.busy).toBe(true)
    result()
    await flush()
    expect(sent()).toEqual(['первое', 'второе', 'третье'])
    expect(sess().queue).toEqual([])
    result()
    await flush()
    expect(sess().state.busy).toBe(false)
  })

  it('↑ забирает последнее сообщение обратно; ✕ убирает', async () => {
    await askClaude('u', '/w', 'первое')
    await askClaude('u', '/w', 'a')
    await askClaude('u', '/w', 'b')
    await askClaude('u', '/w', 'c')
    expect(recallQueued('u')).toBe('c')
    removeQueued('u', sess().queue[0].id)
    expect(sess().queue.map((m) => m.text)).toEqual(['b'])
    expect(recallQueued('u')).toBe('b')
    expect(recallQueued('u')).toBeNull()
  })

  it('⌃C — очередь сохраняется, пауза; ↵ на пустой строке шлёт следующее; esc убирает подсказку', async () => {
    await askClaude('u', '/w', 'первое')
    await askClaude('u', '/w', 'второе')
    await askClaude('u', '/w', 'третье')
    expect(interruptClaude('u')).toBe(true)
    result()
    await flush()
    expect(sent()).toEqual(['первое'])
    expect(sess()).toMatchObject({ paused: true, pauseHint: true })
    expect(sess().queue).toHaveLength(2)
    expect(dismissQueueHint('u')).toBe(true)
    expect(sess()).toMatchObject({ paused: true, pauseHint: false })
    expect(dismissQueueHint('u')).toBe(false)
    expect(sendQueued('u', '/w')).toBe(true)
    await flush()
    expect(sent()).toEqual(['первое', 'второе'])
    expect(sess().paused).toBe(false)
    // Пауза снята: дальше снова по одному за ход.
    result()
    await flush()
    expect(sent()).toEqual(['первое', 'второе', 'третье'])
  })

  it('выход claude — очередь сохраняется на паузе', async () => {
    await askClaude('u', '/w', 'первое')
    await askClaude('u', '/w', 'второе')
    ch!.onExit.onmessage({ code: 1, stderr: 'boom' })
    await flush()
    expect(sent()).toEqual(['первое'])
    expect(sess()).toMatchObject({ paused: true, pauseHint: true })
    expect(sess().queue.map((m) => m.text)).toEqual(['второе'])
    expect(sendQueued('u', '/w')).toBe(true)
    await flush()
    // Перезапуск процесса и отправка.
    expect(calls('claude_start')).toHaveLength(2)
    expect(sent()).toEqual(['первое', 'второе'])
  })

  it('ход идёт — sendQueued ничего не шлёт', async () => {
    await askClaude('u', '/w', 'первое')
    await askClaude('u', '/w', 'второе')
    expect(sendQueued('u', '/w')).toBe(false)
    expect(sent()).toEqual(['первое'])
  })

  it('ждущий вопрос агента — сообщение в очередь, вопрос остаётся', async () => {
    await askClaude('u', '/w', 'первое')
    const input = { questions: [{ question: 'Да?', header: '', multiSelect: false, options: [{ label: 'Да', description: '' }] }] }
    ch!.onLine.onmessage(JSON.stringify({ type: 'control_request', request_id: 'r', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input } }))
    await askClaude('u', '/w', 'пока ждёт')
    expect(sent()).toEqual(['первое'])
    expect(calls('claude_respond')).toHaveLength(0)
    expect(sess().queue.map((m) => m.text)).toEqual(['пока ждёт'])
    const { pendingQuestion } = await import('./reducer')
    expect(pendingQuestion(sess().state)).not.toBeNull()
  })

  it('/model во время хода не ставится в очередь', async () => {
    await askClaude('u', '/w', 'первое')
    void chooseModel('u', '/w', { alias: 'fable', effort: null, persist: false })
    await flush()
    expect(calls('claude_control').some((c) => (c[1] as { request: { subtype: string } }).request.subtype === 'set_model')).toBe(true)
    expect(sess().queue).toEqual([])
  })
})

describe('вложения: отправка и очередь', () => {
  let ch: { onLine: { onmessage(m: string): void } } | null = null
  beforeEach(() => {
    stopClaude('v')
    invoke.mockReset()
    ch = null
    invoke.mockImplementation((cmd: string, a: Record<string, unknown>) => {
      if (cmd === 'claude_start') ch = a as unknown as typeof ch
      return Promise.resolve(cmd === 'claude_start' ? 'pv' : undefined)
    })
  })
  const T = '\ufffc'
  const img = { id: 'i1', kind: 'image' as const, label: 'скрин', path: '/data/attachments/1.png' }
  const file = { id: 'f1', kind: 'file' as const, label: 'Form.tsx', path: '/w/src/Form.tsx' }
  const result = () => ch!.onLine.onmessage(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', session_id: 's1' }))

  it('значки → текст для Claude и файлы для Rust; пузырь «Вы» хранит значки как есть', async () => {
    await askClaude('v', '/w', `вот ${T}, проверь ${T}`, [img, file])
    expect(calls('claude_send')).toEqual([
      ['claude_send', { id: 'pv', text: 'вот [Изображение 1], проверь @src/Form.tsx', files: [{ kind: 'image', path: '/data/attachments/1.png' }] }],
    ])
    expect(items('v').at(-1)).toEqual({ type: 'user', text: `вот ${T}, проверь ${T}`, tokens: [img, file] })
  })

  it('файл пропал к отправке: сообщение уходит, в ленте — тихая заметка', async () => {
    invoke.mockImplementation((cmd: string, a: Record<string, unknown>) => {
      if (cmd === 'claude_start') ch = a as unknown as typeof ch
      if (cmd === 'claude_send') return Promise.resolve(['/data/attachments/1.png: No such file'])
      return Promise.resolve(cmd === 'claude_start' ? 'pv' : undefined)
    })
    await askClaude('v', '/w', `вот ${T}`, [img])
    expect(calls('claude_send')).toHaveLength(1)
    expect(items('v').at(-1)).toEqual({ type: 'note', text: 'Не приложено, Claude получил путь: /data/attachments/1.png: No such file' })
    expect(items('v').some((i) => i.type === 'error')).toBe(false)
  })

  it('в очереди значки едут с сообщением; ↑ возвращает текст со значками; уходят при отправке', async () => {
    await askClaude('v', '/w', 'первое')
    await askClaude('v', '/w', `a ${T}`, [file])
    await askClaude('v', '/w', `b ${T}`, [img])
    const q = useClaudeSessions.getState().sessions.v.queue
    expect(q.map((m) => m.tokens)).toEqual([[file], [img]])
    expect(recallQueued('v')).toEqual({ text: `b ${T}`, tokens: [img] })
    result()
    await flush()
    expect(calls('claude_send').at(-1)![1]).toEqual({ id: 'pv', text: 'a @src/Form.tsx' })
  })
})

describe('editClaude (правка отправленного сообщения)', () => {
  type Ch = { onLine: { onmessage(m: string): void }; onExit: { onmessage(e: unknown): void } }
  let chs: Ch[]
  beforeEach(() => {
    stopClaude('e')
    invoke.mockReset()
    chs = []
    invoke.mockImplementation((cmd: string, a: Record<string, unknown>) => {
      if (cmd === 'claude_start') {
        chs.push(a as unknown as Ch)
        return Promise.resolve(`pe${chs.length}`)
      }
      // Прерванный ход заканчивается result (как у claude после SIGINT).
      if (cmd === 'claude_interrupt') setTimeout(() => line({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 's1' }))
      return Promise.resolve()
    })
  })
  const sess = () => useClaudeSessions.getState().sessions.e
  const line = (ev: object) => chs[chs.length - 1].onLine.onmessage(JSON.stringify(ev))
  const turn = (session: string, uuid: string) => {
    line({ type: 'system', subtype: 'init', session_id: session })
    line({ type: 'assistant', uuid, session_id: session, parent_tool_use_id: null, message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'ок' }] } })
    line({ type: 'result', subtype: 'success', result: 'ок', session_id: session })
  }
  const userAt = (text: string) => items('e').findIndex((i) => i.type === 'user' && i.text === text)
  const order = () => invoke.mock.calls.map((c) => c[0] as string).filter((c) => c !== 'claude_control')

  it('ответ идёт: прервать → дождаться конца хода → остановить → запустить с перемоткой и ответвлением → отправить', async () => {
    await askClaude('e', '/w', 'первое')
    turn('s1', 'm1')
    await askClaude('e', '/w', 'второе')
    expect(sess().state.busy).toBe(true)
    invoke.mockClear()
    expect(await editClaude('e', userAt('второе'), 'второе!')).toBe(true)
    expect(order()).toEqual(['claude_interrupt', 'claude_stop', 'claude_start', 'claude_send'])
    expect(calls('claude_stop')[0][1]).toEqual({ id: 'pe1' })
    expect(calls('claude_start')[0][1]).toMatchObject({ cwd: '/w', resume: 's1', resumeAt: 'm1', fork: true })
    expect(calls('claude_send')[0][1]).toEqual({ id: 'pe2', text: 'второе!' })
    // В ленте: прежний вариант на месте пузыря, новый пузырь — в конце; строки новой сессии нет.
    const it = items('e')
    const i = it.findIndex((x) => x.type === 'replaced')
    expect(it[i]).toMatchObject({ type: 'replaced', count: 1 })
    expect(it.at(-1)).toMatchObject({ type: 'user', text: 'второе!' })
    expect(it.filter((x) => x.type === 'session')).toHaveLength(1)
    // Ответвление сообщает свой id сессии — дальше работаем с ним.
    turn('s2', 'm2')
    expect(sess().state.sessionId).toBe('s2')
    expect(sess().state.chain).toEqual({ session: 's2', uuid: 'm2' })
    // Новое сообщение снова можно изменить: точка — та же, что у заменённого.
    expect(sess().state.edits[it.length - 1].at).toEqual({ session: 's1', uuid: 'm1' })
  })

  it('ответ готов: без прерывания, перезапуск с точки; режим разрешений прежнего процесса сохраняется', async () => {
    await askClaude('e', '/w', 'первое')
    turn('s1', 'm1')
    await askClaude('e', '/w', 'второе')
    turn('s1', 'm2')
    const prev = useSettings.getState().settings
    useSettings.setState({ settings: { ...prev, claudePermissionMode: 'bypassPermissions' } })
    try {
      invoke.mockClear()
      expect(await editClaude('e', userAt('второе'), 'иначе')).toBe(true)
      expect(order()).toEqual(['claude_stop', 'claude_start', 'claude_send'])
      expect(calls('claude_start')[0][1]).toMatchObject({ resume: 's1', resumeAt: 'm1', fork: true, permissionMode: 'acceptEdits' })
    } finally {
      useSettings.setState({ settings: prev })
    }
  })

  it('первое сообщение сессии — новая сессия без --resume', async () => {
    await askClaude('e', '/w', 'первое')
    turn('s1', 'm1')
    await askClaude('e', '/w', 'второе')
    turn('s1', 'm2')
    invoke.mockClear()
    expect(await editClaude('e', userAt('первое'), 'с начала')).toBe(true)
    const a = calls('claude_start')[0][1] as Record<string, unknown>
    expect(a.resume).toBeNull()
    expect(a).not.toHaveProperty('resumeAt')
    expect(a).not.toHaveProperty('fork')
    const it = items('e')
    expect(it.find((x) => x.type === 'replaced')).toMatchObject({ count: 2 })
    expect(it.at(-1)).toMatchObject({ type: 'user', text: 'с начала' })
  })

  it('точка неизвестна — false, процесс не трогаем', async () => {
    await askClaude('e', '/w', 'первое')
    turn('s1', 'm1')
    useClaudeSessions.setState((st) => ({ sessions: { ...st.sessions, e: { ...st.sessions.e, state: { ...st.sessions.e.state, edits: {} } } } }))
    invoke.mockClear()
    expect(await editClaude('e', userAt('первое'), 'x')).toBe(false)
    expect(order()).toEqual([])
  })

  it('очередь остаётся и уходит после исправленного ответа (без паузы)', async () => {
    await askClaude('e', '/w', 'первое')
    turn('s1', 'm1')
    await askClaude('e', '/w', 'второе')
    await askClaude('e', '/w', 'потом')
    expect(sess().queue.map((m) => m.text)).toEqual(['потом'])
    expect(await editClaude('e', userAt('второе'), 'второе!')).toBe(true)
    expect(sess().queue.map((m) => m.text)).toEqual(['потом'])
    expect(sess().paused).toBe(false)
    expect(calls('claude_send').map((c) => (c[1] as { text: string }).text)).toEqual(['первое', 'второе', 'второе!'])
    turn('s2', 'm3')
    await flush()
    expect(calls('claude_send').map((c) => (c[1] as { text: string }).text)).toEqual(['первое', 'второе', 'второе!', 'потом'])
    expect(sess().queue).toEqual([])
  })
})

describe('clearClaude (/clear)', () => {
  beforeEach(() => {
    stopClaude('p')
    invoke.mockReset()
    invoke.mockImplementation((cmd: string) => Promise.resolve(cmd === 'claude_start' ? 'proc-1' : undefined))
  })

  it('останавливает процесс и забывает сессию: следующий запуск — без --resume, очередь пуста', async () => {
    enterClaude('p', '/w')
    await askClaude('p', '/w', 'первый')
    useClaudeSessions.setState((st) => ({
      sessions: { ...st.sessions, p: { ...st.sessions.p, state: { ...st.sessions.p.state, sessionId: 'old', busy: true, contextUsed: 5000 } } },
    }))
    await askClaude('p', '/w', 'в очередь')
    expect(useClaudeSessions.getState().sessions.p.queue).toHaveLength(1)
    const before = items('p').length
    clearClaude('p')
    const p = useClaudeSessions.getState().sessions.p
    expect(calls('claude_stop')).toEqual([['claude_stop', { id: 'proc-1' }]])
    expect(p.state.sessionId).toBeNull()
    expect(p.state.busy).toBe(false)
    expect(p.state.contextUsed).toBe(0)
    expect(p.queue).toEqual([])
    // Индексы не сдвигаются: лента скрывает прежнее сама.
    expect(items('p')).toHaveLength(before)
    enterClaude('p', '/w')
    await flush()
    expect(calls('claude_start')).toHaveLength(2)
    expect(calls('claude_start')[1][1]).toMatchObject({ cwd: '/w', resume: null })
  })
})

describe('exitClaude (/exit)', () => {
  beforeEach(() => {
    stopClaude('p')
    invoke.mockReset()
    invoke.mockImplementation((cmd: string) => Promise.resolve(cmd === 'claude_start' ? 'proc-1' : undefined))
  })

  it('процесс остановлен, сессия закрыта, карточки остаются; следующий вопрос — новая сессия', async () => {
    enterClaude('p', '/w')
    await askClaude('p', '/w', 'привет')
    const n = items('p').length
    exitClaude('p')
    expect(calls('claude_stop')).toHaveLength(1)
    expect(claudeOpen(useClaudeSessions.getState().sessions.p)).toBe(false)
    expect(items('p')).toHaveLength(n)
    await askClaude('p', '/w', 'снова')
    expect(claudeOpen(useClaudeSessions.getState().sessions.p)).toBe(true)
    expect(calls('claude_start')).toHaveLength(2)
    expect(calls('claude_start')[1][1]).toMatchObject({ resume: null })
    // Новая сессия отмечена строкой в ленте.
    expect(items('p').slice(n).some((i) => i.type === 'session')).toBe(true)
  })

  it('без сессии — ничего', () => {
    exitClaude('p')
    expect(useClaudeSessions.getState().sessions.p).toBeUndefined()
  })
})
