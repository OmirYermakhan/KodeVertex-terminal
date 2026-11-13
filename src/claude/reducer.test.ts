import { describe, expect, it } from 'vitest'
import raw from './fixtures/bash-ls.jsonl?raw'
import { canEdit, editInfo, lastEditable, messagesLabel, newSession, replaceFrom, actionTitle, cancelPrompts, decidePermission, finishQuestion, gotoStep, initialClaude, pendingPrompt, pendingQuestion, recordAnswer, modelLabel, nowLabel, reduceClaude, userSent, dropSuggestion, clearSession, newProcess } from './reducer'
import type { ClaudeState } from './reducer'

const lines = raw
  .split('\n')
  .filter((l) => l.trim())

function run(s: ClaudeState, evs: Array<string | object>, t = 1000): ClaudeState {
  return evs.reduce<ClaudeState>((acc, e) => reduceClaude(acc, e, t), s)
}

const assistant = (content: unknown[], parent: string | null = null, model = 'claude-opus-5-5', usage?: object) => ({
  type: 'assistant',
  parent_tool_use_id: parent,
  message: { model, content, usage },
})
const toolUse = (id: string, name: string, input: object) => ({ type: 'tool_use', id, name, input })
const toolResult = (id: string, content: unknown, isError = false, parent: string | null = null) => ({
  type: 'user',
  parent_tool_use_id: parent,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
})

describe('фикстура bash-ls', () => {
  it('после всех строк собирает модель, карточки, контекст и стоимость', () => {
    const s = run(userSent(initialClaude(), 'покажи файлы', 0), lines)
    expect(s.sessionId).toBe('5d0c3728-a401-4b61-a620-0fa4e7b276f4')
    expect(s.model).toBe('claude-haiku-5-5')
    expect(s.contextMax).toBe(1000000)
    expect(s.costUsd).toBe(0.004824)
    expect(s.busy).toBe(false)
    expect(s.items[0]).toEqual({ type: 'user', text: 'покажи файлы' })
    const action = s.items.find((i) => i.type === 'action')
    expect(action).toMatchObject({
      tool: 'Bash',
      detail: 'ls',
      status: 'done',
      result: 'a.txt\nerr.txt\nsample.jsonl',
      agentId: 'main',
    })
    const texts = s.items.filter((i) => i.type === 'assistant')
    expect(texts).toHaveLength(1)
    expect(texts[0]).toMatchObject({ text: 'В текущей папке три файла: `a.txt`, `err.txt` и `sample.jsonl`.', streaming: false })
    const summary = s.items.at(-1)
    expect(summary).toMatchObject({ type: 'summary', costUsd: 0.004824, isError: false })
    expect(s.agents.find((a) => a.id === 'main')).toMatchObject({ status: 'done', model: 'claude-haiku-5-5', name: 'Главный' })
    // контекст = input + cache_creation + cache_read последнего ответа (2 + 187 + 32668)
    expect(s.contextUsed).toBe(2 + 187 + 32668)
  })

  it('стриминг: после первых text_delta карточка streaming с частичным текстом', () => {
    const idx = lines.findIndex((l) => l.includes('text_delta'))
    expect(idx).toBeGreaterThan(0)
    let s = run(initialClaude(), lines.slice(0, idx + 2))
    const a = s.items.find((i) => i.type === 'assistant')
    expect(a).toMatchObject({ streaming: true, text: 'В текущей папке три файла: `a.txt' })
    s = run(s, lines.slice(idx + 2))
    expect(s.items.filter((i) => i.type === 'assistant')).toHaveLength(1)
  })

  it('не мутирует входное состояние', () => {
    const s0 = userSent(initialClaude(), 'x', 0)
    const snap = JSON.stringify(s0)
    run(s0, lines)
    expect(JSON.stringify(s0)).toBe(snap)
  })
})

describe('субагенты', () => {
  it('Task создаёт агента-ребёнка, его Read даёт now, tool_result завершает', () => {
    let s = userSent(initialClaude(), 'go', 0)
    s = reduceClaude(s, assistant([toolUse('t1', 'Task', { description: 'Разведка кода', prompt: 'p' })]), 10)
    const child = s.agents.find((a) => a.id === 't1')!
    expect(child).toMatchObject({ parentId: 'main', name: 'Разведка кода', status: 'running', startedAt: 10, endedAt: null })
    s = reduceClaude(s, assistant([toolUse('r1', 'Read', { file_path: '/x/form.css' })], 't1', 'claude-haiku-5-5'), 20)
    const c2 = s.agents.find((a) => a.id === 't1')!
    expect(c2.now).toBe('Читает form.css')
    expect(c2.history).toContain('Читает form.css')
    expect(c2.model).toBe('claude-haiku-5-5')
    expect(s.items.find((i) => i.type === 'action' && i.toolUseId === 'r1')).toMatchObject({ agentId: 't1' })
    s = reduceClaude(s, toolResult('r1', 'css', false, 't1'), 30)
    s = reduceClaude(s, toolResult('t1', [{ type: 'text', text: 'готово' }]), 40)
    const c3 = s.agents.find((a) => a.id === 't1')!
    expect(c3).toMatchObject({ status: 'done', endedAt: 40 })
    expect(s.items.find((i) => i.type === 'action' && i.toolUseId === 't1')).toMatchObject({ status: 'done', result: 'готово' })
  })

  it('ошибка tool_result даёт error у действия и агента', () => {
    let s = reduceClaude(initialClaude(), assistant([toolUse('t1', 'Agent', { description: 'D' })]), 1)
    s = reduceClaude(s, toolResult('t1', 'boom', true), 2)
    expect(s.agents.find((a) => a.id === 't1')).toMatchObject({ status: 'error', endedAt: 2 })
    expect(s.items.find((i) => i.type === 'action')).toMatchObject({ status: 'error' })
  })

  it('ранний ребёнок: событие раньше tool_use создаёт «Агент», позже дополняется', () => {
    let s = reduceClaude(initialClaude(), assistant([{ type: 'text', text: 'привет' }], 't9'), 5)
    expect(s.agents.find((a) => a.id === 't9')).toMatchObject({ name: 'Агент', parentId: 'main', status: 'running' })
    s = reduceClaude(s, assistant([toolUse('t9', 'Task', { description: 'Поздний' })]), 6)
    const a = s.agents.filter((x) => x.id === 't9')
    expect(a).toHaveLength(1)
    expect(a[0]).toMatchObject({ name: 'Поздний', startedAt: 5 })
  })

  it('AskUserQuestion переводит агента в waiting, ответ возвращает running', () => {
    let s = reduceClaude(userSent(initialClaude(), 'q', 0), assistant([toolUse('q1', 'AskUserQuestion', { questions: [] })]), 1)
    expect(s.agents.find((a) => a.id === 'main')!.status).toBe('waiting')
    s = reduceClaude(s, toolResult('q1', 'ответ'), 2)
    expect(s.agents.find((a) => a.id === 'main')!.status).toBe('running')
  })
})

describe('TodoWrite', () => {
  it('2 из 3 выполнены → step 3 из 3; n не выше m', () => {
    const todos = (st: string[]) => ({ todos: st.map((status, i) => ({ content: 'c' + i, status })) })
    let s = reduceClaude(initialClaude(), assistant([toolUse('w1', 'TodoWrite', todos(['completed', 'completed', 'pending']))]), 1)
    expect(s.agents.find((a) => a.id === 'main')!.step).toEqual({ n: 3, m: 3 })
    s = reduceClaude(s, assistant([toolUse('w2', 'TodoWrite', todos(['completed', 'completed', 'completed']))]), 2)
    expect(s.agents.find((a) => a.id === 'main')!.step).toEqual({ n: 3, m: 3 })
    s = reduceClaude(s, assistant([toolUse('w3', 'TodoWrite', todos(['in_progress', 'pending', 'pending']))]), 3)
    expect(s.agents.find((a) => a.id === 'main')!.step).toEqual({ n: 1, m: 3 })
  })
})

describe('устойчивость', () => {
  it('мусорные строки и неизвестные события не ломают состояние', () => {
    const s0 = userSent(initialClaude(), 'x', 0)
    const s = run(s0, ['', 'not json', '{"a":', '[]', 'null', '42', { type: 'wat' }, { type: 'assistant' }, { type: 'user', message: 5 }, { type: 'stream_event', event: 7 }, { type: 'result' }])
    expect(s.items[0]).toEqual({ type: 'user', text: 'x' })
    expect(() => JSON.stringify(s)).not.toThrow()
  })

  it('result без результата и is_error даёт карточку ошибки в summary', () => {
    const s = reduceClaude(userSent(initialClaude(), 'x', 0), { type: 'result', is_error: true, result: 'сбой', total_cost_usd: 0.1, duration_ms: 5 }, 9)
    expect(s.items.at(-1)).toEqual({ type: 'summary', text: 'сбой', durationMs: 5, costUsd: 0.1, isError: true })
    expect(s.busy).toBe(false)
    expect(s.agents.find((a) => a.id === 'main')!.status).toBe('error')
  })
})

describe('modelLabel', () => {
  it('разбирает семейство и версию', () => {
    expect(modelLabel('claude-opus-5-5')).toBe('Opus 5.5')
    expect(modelLabel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
    expect(modelLabel('claude-fable-5-2')).toBe('Fable 5.2')
    expect(modelLabel('claude-opus-5-5[1m]')).toBe('Opus 5.5')
    expect(modelLabel('gpt-x')).toBe('gpt-x')
  })
})

describe('actionTitle / nowLabel', () => {
  it('заголовки по инструментам', () => {
    expect(actionTitle('Bash', { command: 'npm test' })).toEqual({ title: 'Запустил команду', detail: 'npm test' })
    expect(actionTitle('Read', { file_path: '/a/b.ts' })).toEqual({ title: 'Прочитал файл', detail: '/a/b.ts' })
    expect(actionTitle('Edit', { file_path: '/a/b.ts', old_string: 'x', new_string: 'y' })).toEqual({ title: 'Изменил файл', detail: '/a/b.ts' })
    expect(actionTitle('Grep', { pattern: 'foo' })).toEqual({ title: 'Искал', detail: 'foo' })
    expect(actionTitle('WebFetch', { url: 'http://x' })).toEqual({ title: 'Открыл страницу', detail: 'http://x' })
    expect(actionTitle('WebSearch', { query: 'q' })).toEqual({ title: 'Искал в сети', detail: 'q' })
    expect(actionTitle('TodoWrite', {}).title).toBe('План')
    expect(actionTitle('Task', { description: 'D' })).toEqual({ title: 'Запустил агента', detail: 'D' })
    expect(actionTitle('Weird', null)).toEqual({ title: 'Weird', detail: '' })
  })
  it('Edit несёт diff', () => {
    const s = reduceClaude(initialClaude(), assistant([toolUse('e1', 'Edit', { file_path: '/p/a.kt', old_string: 'a', new_string: 'b' })]), 1)
    expect(s.items[0]).toMatchObject({ diff: { before: 'a', after: 'b', path: '/p/a.kt' } })
  })
  it('now-метки', () => {
    expect(nowLabel('Bash', { command: 'npm test' })).toBe('Запускает npm test')
    expect(nowLabel('Read', { file_path: '/x/form.css' })).toBe('Читает form.css')
    expect(nowLabel('Write', { file_path: '/x/PaymentService.kt' })).toBe('Пишет PaymentService.kt')
    expect(nowLabel('Grep', { pattern: 'foo' })).toBe('Ищет foo')
  })
})

describe('очередь сообщений', () => {
  const result = (o: object = {}) => ({ type: 'result', result: 'ok', duration_ms: 1, total_cost_usd: 0, ...o })

  it('два сообщения подряд: первый result не снимает busy и не завершает главного', () => {
    let s = userSent(userSent(initialClaude(), 'a', 0), 'b', 0)
    expect(s.pending).toBe(2)
    s = reduceClaude(s, result(), 1)
    expect(s.busy).toBe(true)
    expect(s.agents.find((a) => a.id === 'main')!.status).toBe('running')
    s = reduceClaude(s, result(), 2)
    expect(s.busy).toBe(false)
    expect(s.pending).toBe(0)
    expect(s.agents.find((a) => a.id === 'main')!.status).toBe('done')
    // Лишний result не уводит счётчик в минус.
    expect(reduceClaude(s, result(), 3).pending).toBe(0)
  })

  it('result закрывает незавершённые действия и субагентов хода', () => {
    let s = userSent(initialClaude(), 'a', 0)
    s = run(s, [assistant([toolUse('t1', 'Task', { description: 'Поиск' })]), assistant([toolUse('r1', 'Read', { file_path: '/x' })], 't1')])
    s = reduceClaude(s, result({ is_error: true }), 5)
    expect(s.items.filter((i) => i.type === 'action').map((i) => (i as { status: string }).status)).toEqual(['error', 'error'])
    expect(s.agents.find((a) => a.id === 't1')).toMatchObject({ status: 'error', endedAt: 5 })
    s = run(userSent(s, 'b', 6), [assistant([toolUse('t2', 'Task', { description: 'Ещё' })]), result()])
    expect(s.agents.find((a) => a.id === 't2')!.status).toBe('done')
    expect(s.items.filter((i) => i.type === 'action').every((i) => (i as { status: string }).status !== 'running')).toBe(true)
  })
})

describe('control_response (выбор модели)', () => {
  const resp = (response: object, subtype = 'success') => ({
    type: 'control_response',
    response: { subtype, request_id: 'kv-1', response },
  })

  it('get_settings: применённые модель и усилие, модель из настроек', () => {
    const s = reduceClaude(
      initialClaude(),
      resp({ effective: { model: 'opus[1m]' }, applied: { model: 'claude-opus-5-5', effort: 'medium' } }),
      0,
    )
    expect(s).toMatchObject({ model: 'claude-opus-5-5', effort: 'medium', defaultModel: 'opus[1m]' })
    expect(s.agents[0].model).toBe('claude-opus-5-5')
    // Без model в настройках — null.
    expect(reduceClaude(s, resp({ effective: {}, applied: { model: 'x', effort: 'low' } }), 0).defaultModel).toBeNull()
  })

  it('set_model: модель меняется сразу (и у главного агента)', () => {
    const s0 = run(initialClaude(), [{ type: 'system', subtype: 'init', model: 'claude-opus-5-5', session_id: 's' }])
    const s = reduceClaude(s0, resp({ model: 'claude-fable-5-2' }), 0)
    expect(s.model).toBe('claude-fable-5-2')
    expect(s.agents[0].model).toBe('claude-fable-5-2')
    expect(s.effort).toBeNull()
  })

  it('ошибки и чужие ответы не меняют состояние', () => {
    const s = initialClaude()
    expect(reduceClaude(s, resp({ model: 'claude-fable-5-2' }, 'error'), 0)).toBe(s)
    expect(reduceClaude(s, { type: 'control_response', response: null }, 0)).toBe(s)
    expect(reduceClaude(s, resp({}), 0)).toBe(s)
  })
})

describe('вопросы агента (can_use_tool AskUserQuestion)', () => {
  const qInput = {
    questions: [
      { question: 'Цвет?', header: 'Цвет', multiSelect: false, options: [{ label: 'Red', description: '' }] },
      { question: 'Размер?', header: 'Размер', multiSelect: true, options: [{ label: 'S', description: '' }, { label: 'M', description: '' }] },
    ],
  }
  const ask = (parent: string | null = null) => [
    assistant([toolUse('tuQ', 'AskUserQuestion', qInput)], parent),
    { type: 'control_request', request_id: 'rq', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: qInput, tool_use_id: 'tuQ' } },
  ]

  it('карточка вопроса у агента инструмента, агент ждёт', () => {
    const s = run(userSent(initialClaude(), 'x', 0), ask())
    const q = s.items.find((i) => i.type === 'question')!
    expect(q).toMatchObject({ type: 'question', requestId: 'rq', agentId: 'main', step: 0, answers: [], done: false })
    expect(s.agents[0].status).toBe('waiting')
    // Повтор того же запроса не дублирует карточку.
    expect(reduceClaude(s, ask()[1], 0).items.filter((i) => i.type === 'question')).toHaveLength(1)
  })

  it('ответы по вкладкам, шаг отправки, закрытие только когда всё отвечено', () => {
    let s = run(userSent(initialClaude(), 'x', 0), ask())
    s = recordAnswer(s, 'rq', 0, 'Red')
    expect(pendingQuestion(s)).toMatchObject({ step: 1, answers: ['Red', ''], done: false })
    expect(finishQuestion(s, 'rq')).toBe(s)
    s = recordAnswer(s, 'rq', 1, 'S, M')
    // Два вопроса — третий шаг «Отправить ответы».
    expect(pendingQuestion(s)).toMatchObject({ step: 2, answers: ['Red', 'S, M'] })
    s = gotoStep(s, 'rq', 0)
    expect(pendingQuestion(s)!.step).toBe(0)
    expect(gotoStep(s, 'rq', 3)).toBe(s)
    s = finishQuestion(s, 'rq')
    expect(pendingQuestion(s)).toBeNull()
    expect(s.items.find((i) => i.type === 'question')).toMatchObject({ done: true })
    expect(recordAnswer(s, 'rq', 0, 'x')).toBe(s)
    expect(recordAnswer(s, 'нет', 0, 'x')).toBe(s)
  })

  it('прочий инструмент — запрос разрешения; решение, отмена CLI и конец хода', () => {
    const perm = (id: string) => ({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'git push' } } })
    let s = run(userSent(initialClaude(), 'x', 0), [perm('p1')])
    expect(pendingPrompt(s)).toMatchObject({ type: 'permission', tool: 'Bash', requestId: 'p1', done: false })
    expect(s.agents[0]).toMatchObject({ status: 'waiting', now: 'Ждёт разрешения' })
    s = decidePermission(s, 'p1', 'deny')
    expect(pendingPrompt(s)).toBeNull()
    expect(s.items.at(-1)).toMatchObject({ done: true, decision: 'deny' })
    // control_cancel_request — только свой запрос.
    s = run(s, [perm('p2'), perm('p3'), { type: 'control_cancel_request', request_id: 'p2' }])
    expect(pendingPrompt(s)!.requestId).toBe('p3')
    expect(s.items.find((i) => i.type === 'permission' && i.requestId === 'p2')).toMatchObject({ cancelled: 'stop' })
    // Конец хода — ждущие отменены.
    s = reduceClaude(s, { type: 'result', result: 'ok', session_id: 's' }, 0)
    expect(pendingPrompt(s)).toBeNull()
    expect(cancelPrompts(s)).toBe(s)
  })
})

describe('итог не повторяет ответ', () => {
  const answer = 'Есть два пути:\n\n1. **Путь кода**\n2. **Путь запроса**'
  it('result совпадает с ответом этого хода — итог без текста', () => {
    const s = run(userSent(initialClaude(), 'объясни', 0), [
      assistant([{ type: 'text', text: answer }]),
      { type: 'result', result: answer + '\n', total_cost_usd: 0.29, duration_ms: 52_600 },
    ])
    expect(s.items.filter((i) => i.type === 'assistant')).toHaveLength(1)
    expect(s.items.at(-1)).toMatchObject({ type: 'summary', text: '', costUsd: 0.29 })
  })
  it('ответ прошлого хода не считается; без ответа текст итога остаётся', () => {
    const s1 = run(userSent(initialClaude(), 'a', 0), [assistant([{ type: 'text', text: 'да' }]), { type: 'result', result: 'да' }])
    const s2 = run(userSent(s1, 'b', 0), [{ type: 'result', result: 'да' }])
    expect(s2.items.at(-1)).toMatchObject({ type: 'summary', text: 'да' })
  })
})

describe('правка сообщения: точки перемотки', () => {
  const SID = '5d0c3728-a401-4b61-a620-0fa4e7b276f4'
  const res = { type: 'result', subtype: 'success', result: 'ok', session_id: SID }
  const asst = (uuid: string, parent: string | null = null) => ({ ...assistant([{ type: 'text', text: 'ответ' }], parent), uuid, session_id: SID })

  it('первое сообщение — новая сессия; следующее — после последнего ответа главного агента предыдущего хода', () => {
    let s = run(userSent(initialClaude(), 'покажи файлы', 0), lines)
    expect(s.edits[0]).toEqual({ at: 'fresh', epoch: 0 })
    // В фикстуре несколько событий assistant за ход: точка — последнее перед result.
    expect(s.chain).toEqual({ session: SID, uuid: '1c421479-681d-4410-bdf7-f122f19b07c1' })
    s = userSent(s, 'ещё', 0)
    const i = s.items.length - 1
    expect(s.edits[i]).toEqual({ at: { session: SID, uuid: '1c421479-681d-4410-bdf7-f122f19b07c1' }, epoch: 0 })
  })

  it('сообщения субагентов цепочку не двигают', () => {
    let s = run(userSent(initialClaude(), 'a', 0), [asst('m1'), asst('sub-1', 'tu1'), res])
    expect(s.chain?.uuid).toBe('m1')
    s = run(s, [asst('-флаг')])
    expect(s.chain?.uuid).toBe('m1')
  })

  it('точка неизвестна (сессия есть, ответа с uuid не было) — изменить нельзя', () => {
    const s0 = { ...initialClaude(), sessionId: 'other' }
    const s = userSent(s0, 'x', 0)
    expect(s.edits[0]).toEqual({ at: null, epoch: 0 })
    expect(canEdit(s, 0)).toBe(false)
    expect(editInfo(s, 0)).toBeNull()
    expect(lastEditable(s)).toBe(-1)
  })

  it('новая сессия (другой каталог) — прежние сообщения не правятся', () => {
    let s = run(userSent(initialClaude(), 'a', 0), [asst('m1'), res])
    expect(canEdit(s, 0)).toBe(true)
    s = newSession(s)
    expect(s.chain).toBeNull()
    expect(canEdit(s, 0)).toBe(false)
    s = userSent(s, 'b', 0)
    expect(s.edits[s.items.length - 1]).toEqual({ at: 'fresh', epoch: 1 })
  })

  it('editInfo: номер, сколько после, идёт ли ответ, были ли правки файлов', () => {
    let s = run(userSent(initialClaude(), 'a', 0), [asst('m1'), res])
    s = run(userSent(s, 'b', 0), [assistant([toolUse('t1', 'Edit', { file_path: '/x', old_string: '1', new_string: '2' })]), toolResult('t1', 'ok'), asst('m2'), res])
    s = userSent(s, 'c', 0)
    const us = s.items.map((it, i) => (it.type === 'user' ? i : -1)).filter((i) => i >= 0)
    expect(editInfo(s, us[0])).toEqual({ n: 1, total: 3, after: 2, busy: true, files: true })
    expect(editInfo(s, us[2])).toEqual({ n: 3, total: 3, after: 0, busy: true, files: false })
    expect(lastEditable(s)).toBe(us[2])
  })

  it('replaceFrom: пузырь и всё после него — одной строкой «Прежний вариант», индексы не сдвигаются', () => {
    let s = run(userSent(initialClaude(), 'a', 0), [asst('m1'), res])
    s = run(userSent(s, 'b', 0), [{ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'идёт' } } }])
    const i = s.items.findIndex((it) => it.type === 'user' && it.text === 'b')
    const n = s.items.length
    const r = replaceFrom(s, i)
    expect(r.items).toHaveLength(n)
    const head = r.items[i]
    expect(head.type).toBe('replaced')
    if (head.type !== 'replaced') return
    expect(head.count).toBe(1)
    expect(head.items[0]).toEqual({ type: 'user', text: 'b' })
    // Недоигранный ответ в истории — уже не «идёт».
    expect(head.items.some((it) => it.type === 'assistant' && it.streaming)).toBe(false)
    expect(r.items.slice(i + 1).every((it) => it.type === 'gone')).toBe(true)
    expect(canEdit(r, i)).toBe(false)
  })

  it('messagesLabel склоняет', () => {
    expect([1, 2, 4, 5, 11, 12, 21, 22, 25].map(messagesLabel)).toEqual([
      '1 сообщение', '2 сообщения', '4 сообщения', '5 сообщений', '11 сообщений', '12 сообщений', '21 сообщение', '22 сообщения', '25 сообщений',
    ])
  })
})

describe('подсказка следующего сообщения (prompt_suggestion)', () => {
  const result = { type: 'result', result: 'ok', duration_ms: 1, total_cost_usd: 0 }
  const sg = (suggestion: unknown) => ({ type: 'prompt_suggestion', suggestion, uuid: 'u', session_id: 's' })
  const afterTurn = () => reduceClaude(userSent(initialClaude(), 'привет', 0), result, 500)

  it('после конца хода запоминается с временем этого хода', () => {
    const s = reduceClaude(afterTurn(), sg('  Добавь тесты для этой функции '), 900)
    expect(s.suggestion).toEqual({ text: 'Добавь тесты для этой функции', after: 500 })
  })

  it('во время хода (уже отправлено следующее) и до первого хода — игнор', () => {
    const busy = userSent(afterTurn(), 'ещё', 600)
    expect(reduceClaude(busy, sg('спасибо'), 700).suggestion ?? null).toBeNull()
    expect(reduceClaude(initialClaude(), sg('спасибо'), 700).suggestion ?? null).toBeNull()
  })

  it('пустая, многострочная, не строка — игнор', () => {
    for (const bad of ['', '   ', 'а\nб', 5, null, 'x'.repeat(201)]) {
      expect(reduceClaude(afterTurn(), sg(bad), 900).suggestion ?? null).toBeNull()
    }
  })

  it('отправка, новый result, /clear и «убрать» её снимают', () => {
    const s = reduceClaude(afterTurn(), sg('спасибо, до завтра'), 900)
    expect(s.suggestion).not.toBeNull()
    expect(userSent(s, 'другое', 1000).suggestion).toBeNull()
    expect(dropSuggestion(s).suggestion).toBeNull()
    expect(clearSession(s).suggestion).toBeNull()
    expect(newSession(s).suggestion).toBeNull()
    const again = reduceClaude(userSent(s, 'x', 1000), result, 1200)
    expect(again.suggestion).toBeNull()
    expect(again.turnEndAt).toBe(1200)
  })
})

describe('стоимость хода и сессии', () => {
  const res = (total: number, ms = 1000) => ({ type: 'result', result: 'ok', duration_ms: ms, total_cost_usd: total })
  const reply = (text: string) => assistant([{ type: 'text', text }])
  const turn = (s: ClaudeState, text: string, total: number, ms?: number) => run(userSent(s, 'q', 0), [reply(text), res(total, ms)])

  it('ход стоит разницу нарастающих итогов; цена и время — в последнем ответе хода', () => {
    let s = turn(initialClaude(), 'a', 0.1, 2000)
    s = turn(s, 'b', 0.25, 3000)
    expect(s.costUsd).toBeCloseTo(0.25)
    const sums = s.items.filter((i) => i.type === 'summary')
    expect((sums[1] as { costUsd: number }).costUsd).toBeCloseTo(0.15)
    const last = s.items.filter((i) => i.type === 'assistant').at(-1) as { turn?: { durationMs: number; costUsd: number } }
    expect(last.turn?.durationMs).toBe(3000)
    expect(last.turn?.costUsd).toBeCloseTo(0.15)
  })

  it('перезапуск процесса (--resume, правка) складывает итоги, а не теряет их', () => {
    let s = turn(initialClaude(), 'a', 0.3)
    s = newProcess(s)
    s = turn(s, 'b', 0.05)
    expect(s.costUsd).toBeCloseTo(0.35)
    const sum = s.items.filter((i) => i.type === 'summary').at(-1) as { costUsd: number }
    expect(sum.costUsd).toBeCloseTo(0.05)
  })

  it('восстановленная сессия (только costUsd) продолжает счёт после запуска процесса', () => {
    const s = newProcess({ ...initialClaude(), costUsd: 0.42 })
    expect(turn(s, 'a', 0.08).costUsd).toBeCloseTo(0.5)
  })

  it('/clear обнуляет итог', () => {
    const s = clearSession(newProcess(turn(initialClaude(), 'a', 0.3)))
    expect(s.costUsd).toBe(0)
    expect(turn(newProcess(s), 'b', 0.02).costUsd).toBeCloseTo(0.02)
  })

  it('сообщение из очереди между ответом и result не мешает подвалу', () => {
    let s = userSent(initialClaude(), 'q1', 0)
    s = run(s, [reply('ответ')])
    s = userSent(s, 'q2', 0)
    s = run(s, [res(0.1, 500)])
    const a = s.items.find((i) => i.type === 'assistant') as { turn?: { costUsd: number } }
    expect(a.turn?.costUsd).toBeCloseTo(0.1)
  })

  it('ход без текста главного агента — подвала нет, итог на карточке «Итог»', () => {
    const s = run(userSent(initialClaude(), 'q', 0), [res(0.2)])
    expect(s.items.some((i) => i.type === 'assistant')).toBe(false)
    expect(s.items.at(-1)).toMatchObject({ type: 'summary', costUsd: 0.2 })
  })

  it('меньший итог внутри процесса считается новым процессом: сумма не убывает', () => {
    let s = turn(initialClaude(), 'a', 0.5)
    s = turn(s, 'b', 0.1)
    expect(s.costUsd).toBeCloseTo(0.6)
    expect((s.items.filter((i) => i.type === 'summary').at(-1) as { costUsd: number }).costUsd).toBeCloseTo(0.1)
    s = turn(s, 'c', 0.3)
    expect(s.costUsd).toBeCloseTo(0.8)
  })
})
