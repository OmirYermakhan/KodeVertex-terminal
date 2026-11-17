// Фоновые агенты (Agent с run_in_background): фикстура настоящего CLI 2.1.326 и синтетические события.
import { describe, expect, it, vi } from 'vitest'
import { act, createRef } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import raw from './fixtures/background-agent.jsonl?raw'
import { backgroundRunning, backgroundTasks, backgroundWait, initialClaude, mainStale, reduceClaude, settleMain, stopBackground, userSent, type Agent, type ClaudeState } from './reducer'
import { AgentsPanel, agentsHeader, FINISHED_VISIBLE_MS, visibleAgents, type AgentsPanelHandle } from './AgentsPanel'
import { BackgroundWaitRow, bgWaitText } from './cards/ThinkingRow'
import { agentEvents } from '../notify/notify'
import { sessionStatus } from '../ui/tabStatus'

const lines = raw.split('\n').filter((l) => l.trim())
const BG = 'toolu_01QWFHK2qvq5NrX6HAMNrYvY'
const BASH_IN_BG = 'toolu_018Htzc6N15iK28msEcm1nBE'

/** Строки фикстуры с 1-й по n-ю (время растёт на 100 мс на строку). */
function upTo(n: number, s0: ClaudeState = userSent(initialClaude(), 'go', 0)): ClaudeState {
  return lines.slice(0, n).reduce((s, l, i) => reduceClaude(s, l, 100 * (i + 1)), s0)
}
const at = (pred: (l: string) => boolean, from = 0) => lines.findIndex((l, i) => i >= from && pred(l))
const agentOf = (s: ClaudeState, id: string) => s.agents.find((a) => a.id === id)!
const main = (s: ClaudeState) => agentOf(s, 'main')

const firstResult = at((l) => l.includes('"type": "result"'))
const bgNotice = at((l) => l.includes('"task_notification"') && l.includes(`"tool_use_id": "${BG}"`))
const lastResult = at((l) => l.includes('"type": "result"'), firstResult + 1)

describe('фикстура background-agent (настоящий CLI)', () => {
  it('порядок событий: result хода раньше task_notification фонового агента, потом CLI сам начинает ход', () => {
    expect(firstResult).toBeGreaterThan(0)
    expect(bgNotice).toBeGreaterThan(firstResult)
    expect(lastResult).toBeGreaterThan(bgNotice)
  })

  it('tool_result «запущен» не завершает фонового агента: он работает, помечен фоновым, с задачей CLI', () => {
    const launched = at((l) => l.includes(`"tool_use_id": "${BG}", "type": "tool_result"`))
    const s = upTo(launched + 1)
    expect(agentOf(s, BG)).toMatchObject({ name: 'sleeper', status: 'running', background: true, taskId: 'a2a42e766b34b5718', endedAt: null })
    expect(agentOf(s, BG).model).toBe('claude-haiku-5-5')
    // Служебный текст CLI («Async agent launched…») в карточке не показываем.
    expect(s.items.find((it) => it.type === 'action' && it.toolUseId === BG)).toMatchObject({ status: 'done', result: 'Запущен в фоне' })
  })

  it('task_progress: токены и число инструментов', () => {
    const s = upTo(at((l) => l.includes('"task_progress"')) + 1)
    expect(agentOf(s, BG)).toMatchObject({ tokens: 20816, toolUses: 1, status: 'running' })
  })

  it('после result хода главный ждёт фоновых, а не «готов»; его действия идут дальше', () => {
    const s = upTo(firstResult + 1)
    expect(s.busy).toBe(false)
    expect(main(s)).toMatchObject({ status: 'running', now: 'Ждёт фоновых агентов: 1', endedAt: null })
    expect(agentOf(s, BG).status).toBe('running')
    expect(s.items.find((it) => it.type === 'action' && it.toolUseId === BASH_IN_BG)).toMatchObject({ status: 'running' })
    expect(backgroundWait(s)).toBe(1)
    expect(sessionStatus(s)).toEqual({ status: 'running', doneAt: 0 })
  })

  it('task_notification: агент готов, с итоговыми токенами; главный «думает» до своего хода', () => {
    const s = upTo(bgNotice + 1)
    expect(agentOf(s, BG)).toMatchObject({ status: 'done', now: 'Готово', endedAt: 100 * (bgNotice + 1), tokens: 27535 })
    expect(backgroundRunning(s)).toBe(0)
    expect(main(s)).toMatchObject({ status: 'running', now: 'Думает' })
  })

  it('ход, начатый CLI, закрывает главного: «готово» одно — после фонового агента', () => {
    let prev = userSent(initialClaude(), 'go', 0)
    const done: string[] = []
    lines.forEach((l, i) => {
      const next = reduceClaude(prev, l, 100 * (i + 1))
      for (const ev of agentEvents(prev.agents, next.agents)) if (ev.kind === 'done') done.push(`${ev.agent.id}@${i}`)
      prev = next
    })
    expect(done).toEqual([`${BG}@${bgNotice}`, `main@${lastResult}`])
    expect(prev).toMatchObject({ busy: false, pending: 0 })
    expect(main(prev)).toMatchObject({ status: 'done', now: 'Готово' })
    expect(prev.items.filter((it) => it.type === 'assistant' && it.agentId === 'main').map((it) => it.type === 'assistant' && it.text).at(-1)).toBe('done')
  })

  it('команда внутри субагента (task local_bash) агентов не создаёт и не трогает', () => {
    const s = upTo(lines.length)
    expect(s.agents.map((a) => a.id)).toEqual(['main', BG])
  })
})

const ev = (o: object) => JSON.stringify(o)
const agentUse = (id: string, input: object) =>
  ev({ type: 'assistant', parent_tool_use_id: null, message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name: 'Agent', input }] } })
const launchedResult = (id: string) =>
  ev({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'Async agent launched successfully.' }] }, tool_use_result: { status: 'async_launched', isAsync: true } })
const result = (isError = false) => ev({ type: 'result', subtype: isError ? 'error_during_execution' : 'success', is_error: isError, result: '', duration_ms: 10, total_cost_usd: 0 })
const notice = (toolUseId: string, status: string) => ev({ type: 'system', subtype: 'task_notification', task_id: `t-${toolUseId}`, tool_use_id: toolUseId, status, summary: '' })

function twoBackground(): ClaudeState {
  let s = userSent(initialClaude(), 'go', 0)
  s = reduceClaude(s, agentUse('a1', { description: 'Первый', prompt: 'p', run_in_background: true }), 1)
  s = reduceClaude(s, agentUse('a2', { description: 'Второй', prompt: 'p', run_in_background: true }), 2)
  s = reduceClaude(s, launchedResult('a1'), 3)
  s = reduceClaude(s, launchedResult('a2'), 4)
  return reduceClaude(s, result(), 5)
}

describe('фоновые агенты: синтетические события', () => {
  it('run_in_background в input — фоновый сразу; число ждущих убывает по уведомлениям', () => {
    let s = twoBackground()
    expect(main(s).now).toBe('Ждёт фоновых агентов: 2')
    s = reduceClaude(s, notice('a1', 'completed'), 6)
    expect(main(s).now).toBe('Ждёт фоновых агентов: 1')
    expect(backgroundWait(s)).toBe(1)
    s = reduceClaude(s, notice('a2', 'failed'), 7)
    expect(agentOf(s, 'a2')).toMatchObject({ status: 'error', now: 'Ошибка', endedAt: 7 })
    expect(backgroundWait(s)).toBe(0)
  })

  it('stopped/killed — «Остановлено» без уведомления «закончил»', () => {
    const s0 = twoBackground()
    const s = reduceClaude(s0, notice('a1', 'stopped'), 6)
    expect(agentOf(s, 'a1')).toMatchObject({ status: 'done', now: 'Остановлено' })
    expect(agentEvents(s0.agents, s.agents).filter((e) => e.kind === 'done')).toEqual([])
    expect(agentOf(reduceClaude(s0, notice('a2', 'killed'), 6), 'a2').now).toBe('Остановлено')
  })

  it('task_started с is_backgrounded делает агента фоновым (без run_in_background в input)', () => {
    let s = userSent(initialClaude(), 'go', 0)
    s = reduceClaude(s, agentUse('a1', { description: 'D', prompt: 'p' }), 1)
    s = reduceClaude(s, ev({ type: 'system', subtype: 'task_started', task_id: 'tk', tool_use_id: 'a1', is_backgrounded: true }), 2)
    s = reduceClaude(s, ev({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a1', content: 'ok' }] } }), 3)
    expect(agentOf(s, 'a1')).toMatchObject({ status: 'running', background: true, taskId: 'tk' })
    // Событие задачи без tool_use_id находит агента по task_id.
    s = reduceClaude(s, ev({ type: 'system', subtype: 'task_notification', task_id: 'tk', status: 'completed' }), 4)
    expect(agentOf(s, 'a1').status).toBe('done')
  })

  it('обычный (не фоновый) агент — как раньше: tool_result завершает, result хода закрывает остальных', () => {
    let s = userSent(initialClaude(), 'go', 0)
    s = reduceClaude(s, agentUse('a1', { description: 'D', prompt: 'p' }), 1)
    s = reduceClaude(s, agentUse('a2', { description: 'E', prompt: 'p' }), 1)
    s = reduceClaude(s, ev({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a1', content: 'итог' }] } }), 2)
    expect(agentOf(s, 'a1')).toMatchObject({ status: 'done', endedAt: 2 })
    s = reduceClaude(s, result(), 3)
    expect(agentOf(s, 'a2')).toMatchObject({ status: 'done', endedAt: 3 })
    expect(main(s).status).toBe('done')
    // Позднее уведомление о законченном агенте ничего не меняет.
    expect(reduceClaude(s, notice('a1', 'failed'), 4).agents).toBe(s.agents)
  })

  it('ошибка хода не скрывается ожиданием фоновых', () => {
    let s = userSent(initialClaude(), 'go', 0)
    s = reduceClaude(s, agentUse('a1', { description: 'D', run_in_background: true }), 1)
    s = reduceClaude(s, launchedResult('a1'), 2)
    s = reduceClaude(s, result(true), 3)
    expect(main(s).status).toBe('error')
    expect(agentOf(s, 'a1').status).toBe('running')
  })

  it('новое сообщение, пока ждём фоновых: обычный ход; после него снова ждём', () => {
    let s = userSent(twoBackground(), 'ещё', 10)
    expect(s).toMatchObject({ busy: true, pending: 1 })
    expect(backgroundWait(s)).toBe(0)
    s = reduceClaude(s, result(), 11)
    expect(main(s)).toMatchObject({ status: 'running', now: 'Ждёт фоновых агентов: 2' })
  })
})

describe('панель агентов и лента', () => {
  const bgAgent = (o: Partial<Agent>): Agent => ({ id: 'b', parentId: 'main', name: 'Фон', model: null, status: 'running', now: 'Запускает sleep', history: [], step: null, startedAt: 1000, endedAt: null, tokens: 20_000, background: true, ...o })

  it('метка «фон» у фонового агента, живое время; в заголовке — «в фоне»', () => {
    const s = twoBackground()
    render(<AgentsPanel state={s} onExit={() => {}} now={65_005} />)
    const rows = Array.from(document.querySelectorAll('.row'))
    const a1 = rows.find((r) => r.getAttribute('data-agent-id') === 'a1')!
    expect(a1.querySelector('.n .bg')!.textContent).toBe('фон')
    expect(a1.querySelectorAll('.r')[0].textContent).toBe('1м 05с')
    expect(rows.find((r) => r.getAttribute('data-agent-id') === 'main')!.querySelector('.bg')).toBeNull()
    expect(document.querySelector('.dh')!.textContent).toContain('3 работают · 0 ждут · 0 готовы · 2 в фоне')
  })

  it('заголовок: законченный фоновый в «в фоне» не считается', () => {
    expect(agentsHeader([bgAgent({}), bgAgent({ id: 'c', status: 'done' })]).rest).toEqual(['0 ждут', '1 готов', '1 в фоне'])
  })

  it('строка ленты «Ждём N фоновых агентов»', () => {
    expect(bgWaitText(1)).toBe('Ждём 1 фонового агента')
    expect(bgWaitText(3)).toBe('Ждём 3 фоновых агентов')
    expect(bgWaitText(11)).toBe('Ждём 11 фоновых агентов')
    expect(bgWaitText(21)).toBe('Ждём 21 фонового агента')
    render(<BackgroundWaitRow count={2} />)
    const row = screen.getByRole('status')
    expect(row.className).toContain('thinking')
    expect(row.textContent).toContain('Ждём 2 фоновых агентов')
  })
})

const tasksChanged = (ids: string[]) => ev({ type: 'system', subtype: 'background_tasks_changed', tasks: ids.map((task_id) => ({ task_id, task_type: 'local_agent' })) })
const started = (toolUseId: string, taskId: string) => ev({ type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: toolUseId, is_backgrounded: true })

/** Два фоновых агента с задачами CLI t1/t2, ход главного закончен. */
function twoTasks(): ClaudeState {
  let s = userSent(initialClaude(), 'go', 0)
  s = reduceClaude(s, agentUse('a1', { description: 'Первый', prompt: 'p', run_in_background: true }), 1)
  s = reduceClaude(s, agentUse('a2', { description: 'Второй', prompt: 'p', run_in_background: true }), 1)
  s = reduceClaude(s, started('a1', 't1'), 2)
  s = reduceClaude(s, started('a2', 't2'), 2)
  s = reduceClaude(s, launchedResult('a1'), 3)
  s = reduceClaude(s, launchedResult('a2'), 3)
  return reduceClaude(s, result(), 5)
}

describe('сверка по background_tasks_changed', () => {
  it('фоновый агент, которого нет в списке задач, закончил — даже без task_notification', () => {
    let s = twoTasks()
    s = reduceClaude(s, tasksChanged(['t1', 't2']), 6)
    expect(backgroundRunning(s)).toBe(2)
    s = reduceClaude(s, tasksChanged(['t2']), 7)
    expect(agentOf(s, 'a1')).toMatchObject({ status: 'done', now: 'Готово', endedAt: 7 })
    expect(agentOf(s, 'a2').status).toBe('running')
    expect(main(s).now).toBe('Ждёт фоновых агентов: 1')
    s = reduceClaude(s, tasksChanged([]), 8)
    expect(agentOf(s, 'a2')).toMatchObject({ status: 'done', endedAt: 8 })
    expect(main(s)).toMatchObject({ status: 'running', now: 'Думает' })
    expect(mainStale(s)).toBe(true)
  })

  it('ошибку из task_notification сверка не перекрывает; лишний список ничего не меняет', () => {
    let s = reduceClaude(twoTasks(), ev({ type: 'system', subtype: 'task_notification', task_id: 't1', status: 'failed' }), 6)
    const before = s
    s = reduceClaude(s, tasksChanged(['t2']), 7)
    expect(s).toBe(before)
    expect(agentOf(s, 'a1')).toMatchObject({ status: 'error', endedAt: 6 })
  })

  it('агент без id задачи (список пришёл раньше task_started) не закрывается', () => {
    let s = userSent(initialClaude(), 'go', 0)
    s = reduceClaude(s, agentUse('a1', { description: 'D', run_in_background: true }), 1)
    s = reduceClaude(s, tasksChanged([]), 2)
    expect(agentOf(s, 'a1').status).toBe('running')
  })

  it('id задачи берётся и из agentId запуска (task_started не пришёл)', () => {
    let s = userSent(initialClaude(), 'go', 0)
    s = reduceClaude(s, agentUse('a1', { description: 'D', run_in_background: true }), 1)
    s = reduceClaude(s, ev({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a1', content: 'Async agent launched' }] }, tool_use_result: { status: 'async_launched', agentId: 'tx' } }), 2)
    expect(agentOf(s, 'a1').taskId).toBe('tx')
    s = reduceClaude(reduceClaude(s, result(), 3), tasksChanged([]), 4)
    expect(agentOf(s, 'a1')).toMatchObject({ status: 'done', endedAt: 4 })
  })

  it('фикстура: id задачи из запуска совпадает с task_started, финальный список пуст — все закончили', () => {
    const s = upTo(lines.length)
    expect(s.agents.every((a) => a.status === 'done')).toBe(true)
  })

  it('субагент фонового агента переживает result хода и закрывается вместе с ним', () => {
    let s = userSent(initialClaude(), 'go', 0)
    s = reduceClaude(s, agentUse('a1', { description: 'Фон', run_in_background: true }), 1)
    s = reduceClaude(s, started('a1', 't1'), 1)
    s = reduceClaude(s, launchedResult('a1'), 2)
    s = reduceClaude(s, ev({ type: 'assistant', parent_tool_use_id: 'a1', message: { content: [{ type: 'tool_use', id: 'n1', name: 'Agent', input: { description: 'Вложенный' } }] } }), 3)
    s = reduceClaude(s, result(), 4)
    expect(agentOf(s, 'n1')).toMatchObject({ status: 'running', parentId: 'a1' })
    expect(s.items.find((it) => it.type === 'action' && it.toolUseId === 'n1')).toMatchObject({ status: 'running' })
    s = reduceClaude(s, tasksChanged([]), 5)
    expect(agentOf(s, 'n1')).toMatchObject({ status: 'done', now: 'Остановлено', endedAt: 5 })
    expect(s.items.find((it) => it.type === 'action' && it.toolUseId === 'n1')).toMatchObject({ status: 'done' })
  })
})

describe('главный не висит после фоновых', () => {
  it('result хода закрывает обычных субагентов, даже если tool_result не пришёл', () => {
    let s = userSent(initialClaude(), 'go', 0)
    s = reduceClaude(s, agentUse('a1', { description: 'Обычный' }), 1)
    s = reduceClaude(s, agentUse('b1', { description: 'Фон', run_in_background: true }), 1)
    s = reduceClaude(s, launchedResult('b1'), 2)
    s = reduceClaude(s, result(), 3)
    expect(agentOf(s, 'a1')).toMatchObject({ status: 'done', endedAt: 3 })
    expect(agentOf(s, 'b1').status).toBe('running')
  })

  it('mainStale/settleMain: фоновые закончили, хода нет — главный готов (уведомление «закончил»)', () => {
    let s = reduceClaude(reduceClaude(twoTasks(), notice('a1', 'completed'), 6), notice('a2', 'completed'), 7)
    expect(mainStale(s)).toBe(true)
    const done = settleMain(s, 20)
    expect(main(done)).toMatchObject({ status: 'done', now: 'Готово', endedAt: 20 })
    expect(sessionStatus(done)).toEqual({ status: 'done', doneAt: 20 })
    expect(agentEvents(s.agents, done.agents).map((e) => [e.kind, e.agent.id])).toEqual([['done', 'main']])
    // Пока фоновые работают или идёт ход — не трогаем.
    expect(mainStale(twoTasks())).toBe(false)
    expect(settleMain(twoTasks(), 20)).toEqual(twoTasks())
    expect(mainStale(userSent(s, 'ещё', 8))).toBe(false)
  })

  it('init после фоновых — CLI начал свой ход: занят сразу, а не с первым токеном', () => {
    let s = reduceClaude(reduceClaude(twoTasks(), notice('a1', 'completed'), 6), notice('a2', 'completed'), 7)
    s = reduceClaude(s, ev({ type: 'system', subtype: 'init', session_id: 'x', model: 'claude-opus-5-5' }), 8)
    expect(s).toMatchObject({ busy: true, pending: 1 })
    expect(mainStale(s)).toBe(false)
    // init на старте процесса (главный ещё не работал) хода не начинает.
    const fresh = reduceClaude(initialClaude(), ev({ type: 'system', subtype: 'init', session_id: 'x' }), 1)
    expect(fresh).toMatchObject({ busy: false, pending: 0 })
  })
})

describe('⌃C, пока главный ждёт фоновых', () => {
  it('stopBackground: фоновые и главный — «Остановлено», без уведомлений «закончил»; задачи для stop_task', () => {
    const s0 = twoTasks()
    expect(backgroundTasks(s0)).toEqual(['t1', 't2'])
    const s = stopBackground(s0, 9)
    expect(s.agents.map((a) => [a.id, a.status, a.now])).toEqual([
      ['main', 'done', 'Остановлено'],
      ['a1', 'done', 'Остановлено'],
      ['a2', 'done', 'Остановлено'],
    ])
    expect(s.agents.every((a) => a.endedAt === 9)).toBe(true)
    expect(agentEvents(s0.agents, s.agents)).toEqual([])
    expect(sessionStatus(s)?.status).toBe('done')
    expect(backgroundTasks(s)).toEqual([])
    // Позднее уведомление CLI «stopped» ничего не меняет.
    expect(reduceClaude(s, notice('a1', 'stopped'), 10).agents).toBe(s.agents)
  })

  it('ход идёт — stopBackground не трогает (ход прерывает interrupt)', () => {
    const s = userSent(twoTasks(), 'ещё', 10)
    expect(stopBackground(s, 11)).toBe(s)
  })
})

describe('панель: закончившие уходят через FINISHED_VISIBLE_MS', () => {
  const sub = (o: Partial<Agent>): Agent => ({ id: 'x', parentId: 'main', name: 'Саб', model: null, status: 'done', now: 'Готово', history: [], step: null, startedAt: 0, endedAt: 1000, tokens: 0, ...o })
  const mainA = (o: Partial<Agent> = {}): Agent => ({ ...sub({ id: 'main', parentId: null, name: 'Главный', status: 'waiting', now: '', endedAt: null }), ...o })

  it('visibleAgents: главный всегда, живые всегда, закончившие (готово/ошибка/остановлен) — 3 с', () => {
    const agents = [mainA({ status: 'done', endedAt: 0 }), sub({ id: 'd' }), sub({ id: 'e', status: 'error' }), sub({ id: 's', now: 'Остановлено' }), sub({ id: 'r', status: 'running', endedAt: null }), sub({ id: 'w', status: 'waiting', endedAt: null })]
    expect(visibleAgents(agents, 1000 + FINISHED_VISIBLE_MS - 1)).toBe(agents)
    expect(visibleAgents(agents, 1000 + FINISHED_VISIBLE_MS).map((a) => a.id)).toEqual(['main', 'r', 'w'])
  })

  it('строка уходит сама (часы тикают, пока она видна), заголовок — по видимым', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(10_000)
      const s = { ...initialClaude(), agents: [mainA({ status: 'running', startedAt: 1, endedAt: null }), sub({ id: 'd', endedAt: 9_500 })] }
      render(<AgentsPanel state={s} onExit={() => {}} />)
      const ids = () => Array.from(document.querySelectorAll('.row')).map((r) => r.getAttribute('data-agent-id'))
      expect(ids()).toEqual(['main', 'd'])
      expect(document.querySelector('.dh span')!.textContent).toContain('1 готов')
      act(() => vi.advanceTimersByTime(3000))
      expect(ids()).toEqual(['main'])
      expect(document.querySelector('.dh span')!.textContent).toContain('0 готовы')
    } finally {
      vi.useRealTimers()
    }
  })

  it('часы тикают и без живых агентов, пока закончивший виден; потом останавливаются', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(10_000)
      const s = { ...initialClaude(), agents: [mainA({ status: 'done', startedAt: 1, endedAt: 9_000 }), sub({ id: 'd', endedAt: 9_500 })] }
      render(<AgentsPanel state={s} onExit={() => {}} />)
      expect(document.querySelectorAll('.row')).toHaveLength(2)
      act(() => vi.advanceTimersByTime(3000))
      expect(document.querySelectorAll('.row')).toHaveLength(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('выбранная строка ушла: выбор на главном, подробности закрыты, ↑↓ работают', () => {
    const agents = [mainA({ status: 'running', startedAt: 1, endedAt: null }), sub({ id: 'd', endedAt: 1000 }), sub({ id: 'r', status: 'running', endedAt: null, name: 'Живой' })]
    const s = { ...initialClaude(), agents }
    const ref = createRef<AgentsPanelHandle>()
    const { rerender } = render(<AgentsPanel ref={ref} state={s} onExit={() => {}} now={1500} />)
    act(() => ref.current!.select('d'))
    const box = screen.getByRole('listbox')
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(screen.getByTestId('agent-detail')).toBeTruthy()
    const focused = () => document.querySelector('.row.focus')?.getAttribute('data-agent-id')
    expect(focused()).toBe('d')
    rerender(<AgentsPanel ref={ref} state={s} onExit={() => {}} now={1000 + FINISHED_VISIBLE_MS} />)
    expect(document.querySelector('[data-agent-id="d"]')).toBeNull()
    expect(focused()).toBe('main')
    expect(screen.queryByTestId('agent-detail')).toBeNull()
    fireEvent.keyDown(box, { key: 'ArrowDown' })
    expect(focused()).toBe('r')
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(screen.getByTestId('agent-detail')).toBeTruthy()
  })
})
