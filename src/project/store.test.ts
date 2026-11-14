import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))

const { useProject, statusOf, dirHasChanges } = await import('./store')
import type { Change } from './api'

const reset = () => useProject.setState({ tool: null, root: null, changes: null, notGit: false, tabs: [], active: 0, focusLine: null, claudeTouched: new Set() })

describe('панель', () => {
  beforeEach(reset)
  it('toggle переключает и закрывает', () => {
    const s = () => useProject.getState()
    s().toggle('project')
    expect(s().tool).toBe('project')
    s().toggle('git')
    expect(s().tool).toBe('git')
    s().toggle('git')
    expect(s().tool).toBeNull()
    s().toggle('changes')
    s().close()
    expect(s().tool).toBeNull()
  })
  it('ширина ограничивается и сохраняется', () => {
    useProject.getState().setWidth(100)
    expect(useProject.getState().width).toBe(200)
    useProject.getState().setWidth(9999)
    expect(useProject.getState().width).toBe(600)
    useProject.getState().setWidth(350)
    expect(localStorage.getItem('kv.projectWidth')).toBe('350')
  })
  it('openFile не дублирует вкладку, openDiff различает rev', () => {
    const s = () => useProject.getState()
    s().openFile('a.ts')
    s().openFile('b.ts')
    s().openFile('a.ts')
    expect(s().tabs).toHaveLength(2)
    expect(s().active).toBe(0)
    s().openDiff('a.ts', null)
    s().openDiff('a.ts', null)
    s().openDiff('a.ts', 'abc')
    expect(s().tabs).toHaveLength(4)
    expect(s().active).toBe(3)
  })
  it('closeTab сдвигает активную', () => {
    const s = () => useProject.getState()
    s().openFile('a')
    s().openFile('b')
    s().openFile('c')
    s().closeTab(2)
    expect(s().active).toBe(1)
    s().closeTab(0)
    expect(s().tabs.map((t) => t.rel)).toEqual(['b'])
    expect(s().active).toBe(0)
  })
  it('markClaudeTouched хранит путь относительно корня, чужие игнорирует', () => {
    useProject.setState({ root: '/p' })
    useProject.getState().markClaudeTouched('/p/src/a.ts')
    useProject.getState().markClaudeTouched('/other/x.ts')
    expect([...useProject.getState().claudeTouched]).toEqual(['src/a.ts'])
  })
})

describe('refresh', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    invoke.mockReset()
    invoke.mockResolvedValue([])
    reset()
    useProject.setState({ root: '/p' })
  })
  afterEach(() => vi.useRealTimers())
  const n = () => invoke.mock.calls.filter((c) => c[0] === 'git_status').length

  it('троттлится: серия вызовов — запрос сразу и один хвостовой через 500 мс', async () => {
    const { refresh } = useProject.getState()
    refresh()
    refresh()
    refresh()
    expect(n()).toBe(1)
    await vi.advanceTimersByTimeAsync(499)
    expect(n()).toBe(1)
    await vi.advanceTimersByTimeAsync(2)
    expect(n()).toBe(2)
    expect(invoke).toHaveBeenCalledWith('git_status', { root: '/p' })
    expect(useProject.getState().changes).toEqual([])
  })
  it('«not-git» выставляет notGit', async () => {
    await vi.advanceTimersByTimeAsync(1000)
    invoke.mockRejectedValue('not-git')
    useProject.getState().refresh()
    await vi.advanceTimersByTimeAsync(0)
    expect(useProject.getState().notGit).toBe(true)
  })
})

describe('setRoot', () => {
  beforeEach(() => {
    invoke.mockReset()
    reset()
  })
  it('ответ на прежний cwd, пришедший позже, не перебивает новый корень', async () => {
    const answers: Record<string, (v: string) => void> = {}
    invoke.mockImplementation((cmd: string, a: { cwd?: string }) =>
      cmd === 'project_root' ? new Promise((r) => (answers[a.cwd!] = r)) : Promise.resolve([]),
    )
    useProject.getState().setRoot('/a')
    useProject.getState().setRoot('/b')
    answers['/b']('/b')
    await Promise.resolve()
    answers['/a']('/a')
    await Promise.resolve()
    expect(useProject.getState().root).toBe('/b')
  })
  it('clearClaudeTouched очищает «Claude менял»', () => {
    useProject.setState({ claudeTouched: new Set(['a.ts']) })
    useProject.getState().clearClaudeTouched()
    expect(useProject.getState().claudeTouched.size).toBe(0)
  })
})

const ch = (path: string, status: Change['status']): Change => ({ path, status })
describe('statusOf / dirHasChanges', () => {
  const c = [ch('src/a.ts', 'M'), ch('src/new.ts', '?'), ch('b.ts', 'A'), ch('old.ts', 'D'), ch('r.ts', 'R')]
  it('статусы', () => {
    expect(statusOf(c, 'src/a.ts')).toBe('mod')
    expect(statusOf(c, 'src/new.ts')).toBe('new')
    expect(statusOf(c, 'b.ts')).toBe('add')
    expect(statusOf(c, 'old.ts')).toBe('del')
    expect(statusOf(c, 'r.ts')).toBe('mod')
    expect(statusOf(c, 'zzz')).toBeNull()
    expect(statusOf(null, 'a')).toBeNull()
  })
  it('каталоги', () => {
    expect(dirHasChanges(c, 'src')).toBe(true)
    expect(dirHasChanges(c, 'sr')).toBe(false)
    expect(dirHasChanges(c, 'lib')).toBe(false)
    expect(dirHasChanges(c, '')).toBe(true)
    expect(dirHasChanges(null, 'src')).toBe(false)
  })
})
