import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '../claude/reducer'

const perm = { granted: true }
const sendNotification = vi.fn()
vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: async () => perm.granted,
  requestPermission: async () => (perm.granted ? 'granted' : 'denied'),
  sendNotification: (...a: unknown[]) => sendNotification(...a),
}))
import { useTabs } from '../layout/tabsStore'
import { useUi } from '../ui/uiStore'
import {
  agentEvents, agentText, audioContext, emit, handleWindowFocus, lastQuestion, commandText, needsSystemNotice, openToast, shouldNotifyAgent, shouldNotifyCommand,
  soundFor, TOAST_MS, useToasts, waitingCount,
} from './notify'

const ag = (o: Partial<Agent>): Agent => ({
  id: 'main', parentId: null, name: 'Главный', model: null, status: 'running', now: '', history: [],
  step: null, startedAt: 1, endedAt: null, tokens: 0, ...o,
})

describe('правила «когда уведомлять»', () => {
  it('переходы статусов', () => {
    expect(agentEvents([ag({})], [ag({ status: 'done', now: 'Готово' })]).map((e) => e.kind)).toEqual(['done'])
    expect(agentEvents([ag({})], [ag({ status: 'waiting' })]).map((e) => e.kind)).toEqual(['waiting'])
    expect(agentEvents([ag({})], [ag({ status: 'error' })]).map((e) => e.kind)).toEqual(['error'])
    expect(agentEvents([ag({})], [ag({})])).toEqual([])
    expect(agentEvents([ag({ status: 'done' })], [ag({ status: 'done' })])).toEqual([])
  })
  it('начальное «ждёт» главного и остановка ⌃C — не события', () => {
    expect(agentEvents([], [ag({ status: 'waiting', startedAt: 0 })])).toEqual([])
    expect(agentEvents([ag({})], [ag({ status: 'done', now: 'Остановлено' })])).toEqual([])
  })
  it('субагент, ответивший раньше своего tool_use, тоже считается', () => {
    expect(agentEvents([ag({})], [ag({}), ag({ id: 't1', status: 'done' })]).map((e) => e.agent.id)).toEqual(['t1'])
  })
  it('главный — всегда, субагенты — по настройке, «ждёт» — от любого', () => {
    const sub = { kind: 'done' as const, agent: ag({ id: 't1' }) }
    expect(shouldNotifyAgent({ ...sub, agent: ag({}) }, { notifySubagents: false })).toBe(true)
    expect(shouldNotifyAgent(sub, { notifySubagents: false })).toBe(false)
    expect(shouldNotifyAgent(sub, { notifySubagents: true })).toBe(true)
    expect(shouldNotifyAgent({ kind: 'waiting', agent: ag({ id: 't1' }) }, { notifySubagents: false })).toBe(true)
    expect(shouldNotifyAgent({ kind: 'error', agent: ag({ id: 't1' }) }, { notifySubagents: false })).toBe(false)
  })
  it('долгая команда: строго больше 10 с и по настройке', () => {
    expect(shouldNotifyCommand(10_000, { notifyLongCommands: true })).toBe(false)
    expect(shouldNotifyCommand(10_001, { notifyLongCommands: true })).toBe(true)
    expect(shouldNotifyCommand(60_000, { notifyLongCommands: false })).toBe(false)
    expect(shouldNotifyCommand(null, { notifyLongCommands: true })).toBe(false)
  })
  it('системное уведомление и звук', () => {
    expect(needsSystemNotice(true, true)).toBe(false)
    expect(needsSystemNotice(false, true)).toBe(true)
    expect(needsSystemNotice(true, false)).toBe(true)
    expect(soundFor('done') && soundFor('waiting') && !soundFor('error')).toBe(true)
  })
  it('тексты', () => {
    expect(agentText({ kind: 'waiting', agent: ag({}) })).toBe('! Главный ждёт ответа')
    expect(agentText({ kind: 'error', agent: ag({ name: 'Стили' }) })).toBe('✕ Стили: ошибка')
    expect(agentText({ kind: 'done', agent: ag({ id: 't1', name: 'Архитектор', history: ['Читает pay.kt'] }) })).toBe('✓ Архитектор закончил: прочитал pay.kt')
    expect(commandText('npm test', 12400, 0)).toBe('✓ npm test · 12,4 с')
    expect(commandText('make', 15000, 2)).toBe('✕ make · код 2 · 15,0 с')
  })
  it('счётчик ждущих по всем панелям', () => {
    const s = (...a: Agent[]) => ({ state: { agents: a } })
    expect(waitingCount({ a: s(ag({ status: 'waiting' })), b: s(ag({ status: 'waiting', startedAt: 0 }), ag({ id: 'x', status: 'waiting' })) })).toBe(2)
  })
})

describe('тосты', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useToasts.setState({ toasts: [] })
  })
  afterEach(() => vi.useRealTimers())

  it('исчезает через 6 с, несколько стекаются', () => {
    useToasts.getState().push({ kind: 'done', text: 'a', paneId: 'p', agentId: null })
    vi.advanceTimersByTime(2000)
    useToasts.getState().push({ kind: 'error', text: 'b', paneId: 'p', agentId: null })
    expect(useToasts.getState().toasts).toHaveLength(2)
    vi.advanceTimersByTime(TOAST_MS - 2000)
    expect(useToasts.getState().toasts.map((t) => t.text)).toEqual(['b'])
    vi.advanceTimersByTime(2000)
    expect(useToasts.getState().toasts).toEqual([])
  })

  it('клик: вкладка, панель, агент', () => {
    useTabs.getState().newTab()
    const first = useTabs.getState().tabs[0]
    useTabs.getState().newTab()
    expect(useTabs.getState().active).not.toBe(first.id)
    useToasts.getState().push({ kind: 'waiting', text: 't', paneId: first.focused, agentId: 'a1' })
    openToast(useToasts.getState().toasts[0])
    expect(useTabs.getState().active).toBe(first.id)
    expect(useUi.getState().agentRequest).toMatchObject({ paneId: first.focused, agentId: 'a1' })
    expect(useToasts.getState().toasts).toEqual([])
  })
})

describe('фокус окна после системного уведомления', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useUi.setState({ agentRequest: null })
  })
  afterEach(() => vi.useRealTimers())

  async function notifyFrom(paneId: string, focused = false) {
    const { useSettings } = await import('../settings/store')
    useSettings.setState({ settings: { ...useSettings.getState().settings, notifySystem: true, notifySound: false } })
    vi.spyOn(document, 'hasFocus').mockReturnValue(focused)
    await emit('waiting', '! Главный ждёт ответа', paneId, 'main')
  }

  it('нет разрешения на системные уведомления — переход по фокусу не запоминается', async () => {
    perm.granted = false
    try {
      useTabs.getState().newTab()
      const first = useTabs.getState().tabs[0]
      useTabs.getState().newTab()
      await notifyFrom(first.focused)
      expect(sendNotification).not.toHaveBeenCalled()
      handleWindowFocus()
      expect(useUi.getState().agentRequest).toBeNull()
    } finally {
      perm.granted = true
    }
  })

  it('окно в фокусе (событие в другой вкладке) — уведомление есть, перехода по фокусу нет', async () => {
    useTabs.getState().newTab()
    const first = useTabs.getState().tabs[0]
    useTabs.getState().newTab()
    sendNotification.mockClear()
    await notifyFrom(first.focused, true)
    expect(sendNotification).toHaveBeenCalled()
    handleWindowFocus()
    expect(useUi.getState().agentRequest).toBeNull()
  })

  it('в пределах 30 с — переход к вкладке и агенту, затем забывается', async () => {
    useTabs.getState().newTab()
    const first = useTabs.getState().tabs[0]
    useTabs.getState().newTab()
    await notifyFrom(first.focused)
    vi.advanceTimersByTime(29_000)
    handleWindowFocus()
    expect(useTabs.getState().active).toBe(first.id)
    expect(useUi.getState().agentRequest?.agentId).toBe('main')
    useUi.setState({ agentRequest: null })
    handleWindowFocus()
    expect(useUi.getState().agentRequest).toBeNull()
  })

  it('позже 30 с — не переходит', async () => {
    useTabs.getState().newTab()
    const first = useTabs.getState().tabs[0]
    await notifyFrom(first.focused)
    vi.advanceTimersByTime(31_000)
    handleWindowFocus()
    expect(useUi.getState().agentRequest).toBeNull()
  })
})

describe('текст «закончил»', () => {
  it('главный — последний вопрос, до 60 знаков с …', () => {
    const q = lastQuestion([{ type: 'user', text: 'первый' }, { type: 'assistant' }, { type: 'user', text: 'сделай модуль оплаты' }])
    expect(agentText({ kind: 'done', agent: ag({}) }, q)).toBe('✓ Главный закончил: сделай модуль оплаты')
    const long = agentText({ kind: 'done', agent: ag({}) }, 'я'.repeat(100))
    expect(long).toBe(`✓ Главный закончил: ${'я'.repeat(59)}…`)
  })
})

describe('звук', () => {
  it('приостановленный контекст возобновляется', () => {
    const resume = vi.fn(() => Promise.resolve())
    vi.stubGlobal('AudioContext', class { state = 'suspended'; resume = resume })
    expect(audioContext()).not.toBeNull()
    expect(resume).toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})

describe('долгие команды в alt screen', () => {
  it('vim/less не уведомляют', async () => {
    const { notifyCommandEnd } = await import('./notify')
    useToasts.setState({ toasts: [] })
    notifyCommandEnd('p', 'vim a', 60_000, 0, true)
    expect(useToasts.getState().toasts).toEqual([])
    notifyCommandEnd('p', 'make', 60_000, 0, false)
    expect(useToasts.getState().toasts).toHaveLength(1)
  })
})
