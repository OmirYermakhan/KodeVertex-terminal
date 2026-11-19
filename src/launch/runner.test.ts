import { beforeEach, describe, expect, it, vi } from 'vitest'
import { initialTabsState, useTabs } from '../layout/tabsStore'
import { MAX_IMAGE, folderName, normalizeLaunchers, suggestName, type Launcher } from './launchers'
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

  it('вход с папкой — вкладка открывается в ней', () => {
    openLauncher({ ...L, cwd: '/p/app' })
    const t = launcherTab(useTabs.getState().tabs, 'l1')!
    expect(t.cwd[t.id]).toBe('/p/app')
  })

  it('вход без команды — ничего не ждёт и не запускается повторно', () => {
    const E = { ...L, command: '', cwd: '/p' }
    openLauncher(E)
    const t = launcherTab(useTabs.getState().tabs, 'l1')!
    expect(takePending(t.id)).toBeNull()
    const run = vi.fn(() => true)
    registerPaneRunner(t.id, { run, busy: () => false })
    useTabs.getState().activate(useTabs.getState().tabs[0].id)
    openLauncher(E)
    expect(useTabs.getState().active).toBe(t.id)
    expect(run).not.toHaveBeenCalled()
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
  it('вход только с папкой, картинка и cwd проверяются', () => {
    expect(normalizeLaunchers([{ id: 'a', command: '', cwd: '/x/proj', icon: 'box', color: '#000000' }])).toEqual([
      { id: 'a', name: 'proj', command: '', icon: 'box', color: '#000000', cwd: '/x/proj' },
    ])
    expect(normalizeLaunchers([{ id: 'b', command: '' }])).toEqual([])
    const bad1 = normalizeLaunchers([{ id: 'c', command: 'x', image: 'data:text/html,<b>' }])
    const bad2 = normalizeLaunchers([{ id: 'c', command: 'x', image: 'data:image/png;base64,' + 'A'.repeat(MAX_IMAGE) }])
    const bad3 = normalizeLaunchers([{ id: 'c', command: 'x', cwd: 'rel/path' }])
    for (const r of [bad1, bad2]) expect(r[0]).not.toHaveProperty('image')
    expect(bad3[0]).not.toHaveProperty('cwd')
    const ok = normalizeLaunchers([{ id: 'c', command: 'x', image: 'data:image/png;base64,AAAA' }])
    expect(ok[0].image).toBe('data:image/png;base64,AAAA')
  })
  it('folderName', () => {
    expect(folderName('/a/b/proj/')).toBe('proj')
    expect(folderName('/')).toBe('/')
  })
})
