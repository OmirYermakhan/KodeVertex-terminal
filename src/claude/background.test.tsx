// Фоновые агенты (Agent с run_in_background): фикстура настоящего CLI 2.1.326 и синтетические события.
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import raw from './fixtures/background-agent.jsonl?raw'
import { backgroundRunning, backgroundWait, initialClaude, reduceClaude, userSent, type Agent, type ClaudeState } from './reducer'
import { AgentsPanel, agentsHeader } from './AgentsPanel'
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
