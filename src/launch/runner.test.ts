import { beforeEach, describe, expect, it, vi } from 'vitest'
import { initialTabsState, useTabs } from '../layout/tabsStore'
import { normalizeLaunchers, suggestName, type Launcher } from './launchers'
import { launcherTab, openLauncher, registerPaneRunner, resetRunnersForTest, takePending } from './runner'

const L: Launcher = { id: 'l1', name: 'prod', command: 'ssh deploy@10.0.0.5', icon: 'server', color: '#4f8cff' }

beforeEach(() => {
  resetRunnersForTest()
  useTabs.setState(initialTabsState())
})

describe('openLauncher', () => {
  it('нет вкладки — новая вкладка входа, команда ждёт приглашения', () => {
    openLauncher(L)
    const s = useTabs.getState()
    const t = launcherTab(s.tabs, 'l1')!
    expect(s.tabs).toHaveLength(2)
    expect(s.active).toBe(t.id)
    expect(takePending(t.id)).toBe('ssh deploy@10.0.0.5')
    expect(takePending(t.id)).toBeNull()
  })

  it('сессия идёт — только переключение', () => {
    openLauncher(L)
    const t = launcherTab(useTabs.getState().tabs, 'l1')!
    takePending(t.id)
    const run = vi.fn(() => true)
    registerPaneRunner(t.id, { run, busy: () => true })
    useTabs.getState().activate(useTabs.getState().tabs[0].id)
    openLauncher(L)
    expect(useTabs.getState().active).toBe(t.id)
    expect(run).not.toHaveBeenCalled()
    expect(useTabs.getState().tabs).toHaveLength(2)
  })

  it('вышли с сервера — команда запускается снова', () => {
    openLauncher(L)
    const t = launcherTab(useTabs.getState().tabs, 'l1')!
    takePending(t.id)
    const run = vi.fn(() => true)
    registerPaneRunner(t.id, { run, busy: () => false })
    openLauncher(L)
    expect(run).toHaveBeenCalledWith('ssh deploy@10.0.0.5')
  })

  it('оболочка ещё не готова — команда ждёт', () => {
    openLauncher(L)
    const t = launcherTab(useTabs.getState().tabs, 'l1')!
    takePending(t.id)
    registerPaneRunner(t.id, { run: () => false, busy: () => false })
    openLauncher(L)
    expect(takePending(t.id)).toBe('ssh deploy@10.0.0.5')
  })

  it('вкладку закрыли — следующий клик открывает новую', () => {
    openLauncher(L)
    const t = launcherTab(useTabs.getState().tabs, 'l1')!
    useTabs.getState().closeTab(t.id)
    openLauncher(L)
    const t2 = launcherTab(useTabs.getState().tabs, 'l1')!
    expect(t2.id).not.toBe(t.id)
  })
})

describe('launchers', () => {
  it('нормализация: битые и повторные выбрасываются, значок и цвет по умолчанию', () => {
    expect(
      normalizeLaunchers([
        { id: 'a', name: '', command: ' ssh u@h ', icon: 'nope', color: 'red' },
        { id: 'a', command: 'x' },
        { id: 'b', command: '  ' },
        null,
      ]),
    ).toEqual([{ id: 'a', name: 'ssh u@h', command: 'ssh u@h', icon: 'server', color: '#4f8cff' }])
    expect(normalizeLaunchers('x')).toEqual([])
  })
  it('имя из команды ssh', () => {
    expect(suggestName('ssh -p 2222 deploy@10.0.0.5')).toBe('deploy@10.0.0.5')
    expect(suggestName('ssh prod')).toBe('prod')
    expect(suggestName('kubectl exec -it api -- sh')).toBe('kubectl exec -it api -- ')
  })
})
