import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { applyCompletion, completionContext } from './completion'
import { useCompletion, type FsEntryTS } from './useCompletion'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

const mocked = vi.mocked(invoke)

const dir = (name: string): FsEntryTS => ({ name, isDir: true, isSymlink: false })
const file = (name: string): FsEntryTS => ({ name, isDir: false, isSymlink: false })
const ENTRIES = [dir('docs'), dir('src'), dir('scripts')]

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const key = (k: string, type = 'keydown') => new KeyboardEvent(type, { key: k })
const report = (buffer: string) => ({ cursor: [...buffer].length, buffer })

function setup(cwd = '/p') {
  const write = vi.fn()
  const hook = renderHook(() => useCompletion({ cwd: () => cwd, home: '/h', write }))
  return { write, hook, api: () => hook.result.current }
}

/** fs_list отвечает ENTRIES, fs_preview — пустым каталогом. */
function listAlways(entries: FsEntryTS[] = ENTRIES) {
  mocked.mockImplementation(async (cmd) => {
    if (cmd === 'fs_list') return entries
    return { kind: 'dir', entries: [], total: 0 }
  })
}

async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

describe('useCompletion', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocked.mockReset()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('lists the cwd for `cd sr` and puts src first', async () => {
    listAlways()
    const { api } = setup()
    act(() => api().onReport(report('cd sr')))
    expect(mocked).not.toHaveBeenCalled() // дебаунс
    await tick(30)
    expect(mocked).toHaveBeenCalledWith('fs_list', { dir: '/p', dirsOnly: true, includeHidden: false })
    expect(api().state.open).toBe(true)
    expect(api().state.items[0].name).toBe('src')
    expect(api().state.dir).toBe('/p')
    expect(api().state.selected).toBe(0)
  })

  it('drops a stale fs_list response that arrives last', async () => {
    const first = deferred<FsEntryTS[]>()
    const second = deferred<FsEntryTS[]>()
    mocked.mockImplementation(async (cmd) => {
      if (cmd === 'fs_preview') return { kind: 'dir', entries: [], total: 0 }
      return mocked.mock.calls.filter((c) => c[0] === 'fs_list').length === 1 ? first.promise : second.promise
    })
    const { api } = setup()
    act(() => api().onReport(report('cd s')))
    await tick(30)
    act(() => api().onReport(report('cd sr')))
    await tick(30)
    await act(async () => second.resolve([dir('src'), dir('sr2')]))
    expect(api().state.items.map((i) => i.name)).toEqual(['sr2', 'src'])
    await act(async () => first.resolve([dir('stale')]))
    expect(api().state.items.map((i) => i.name)).toEqual(['sr2', 'src'])
  })

  it('reuses the cached listing while the directory stays the same', async () => {
    listAlways()
    const { api } = setup()
    act(() => api().onReport(report('cd s')))
    await tick(30)
    act(() => api().onReport(report('cd sc')))
    await tick(30)
    expect(mocked.mock.calls.filter((c) => c[0] === 'fs_list')).toHaveLength(1)
    expect(api().state.items[0].name).toBe('scripts')
  })

  it('cycles the selection with ↓ / ↑ and loads the preview of the highlighted entry', async () => {
    listAlways()
    const { api } = setup()
    act(() => api().onReport(report('cd ')))
    await tick(30)
    const names = api().state.items.map((i) => i.name)
    expect(names).toEqual(['docs', 'scripts', 'src'])
    let eaten = false
    act(() => void (eaten = api().onKey(key('ArrowDown'))))
    expect(eaten).toBe(true)
    expect(api().state.selected).toBe(1)
    act(() => void api().onKey(key('ArrowUp')))
    act(() => void api().onKey(key('ArrowUp')))
    expect(api().state.selected).toBe(2)
    await tick(80)
    expect(mocked).toHaveBeenLastCalledWith('fs_preview', { path: '/p/src' })
    expect(api().state.preview).toEqual({ kind: 'dir', entries: [], total: 0 })
  })

  it('Tab writes applyCompletion for the selected entry', async () => {
    listAlways()
    const { api, write } = setup()
    act(() => api().onReport(report('cd sr')))
    await tick(30)
    let eaten = false
    act(() => void (eaten = api().onKey(key('Tab'))))
    expect(eaten).toBe(true)
    const ctx = completionContext('cd sr', 5)!
    expect(write).toHaveBeenCalledWith(applyCompletion(ctx, dir('src')))
    expect(write).toHaveBeenCalledWith('\x7f\x7fsrc/')
  })

  it('↵ on cd writes the completion without the trailing slash and then \\r', async () => {
    listAlways()
    const { api, write } = setup()
    act(() => api().onReport(report('cd sr')))
    await tick(30)
    act(() => void api().onKey(key('Enter')))
    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith('\x7f\x7fsrc\r')
    expect(api().state.open).toBe(false)
  })

  it('↵ on other commands only substitutes', async () => {
    listAlways([file('README.md')])
    const { api, write } = setup()
    act(() => api().onReport(report('cat READ')))
    await tick(30)
    expect(mocked).toHaveBeenCalledWith('fs_list', { dir: '/p', dirsOnly: false, includeHidden: false })
    act(() => void api().onKey(key('Enter')))
    expect(write).toHaveBeenCalledWith('\x7f\x7f\x7f\x7fREADME.md')
  })

  it('esc closes; onKey stays false until the next report', async () => {
    listAlways()
    const { api, write } = setup()
    act(() => api().onReport(report('cd sr')))
    await tick(30)
    let eaten = false
    act(() => void (eaten = api().onKey(key('Escape'))))
    expect(eaten).toBe(true)
    expect(api().state.open).toBe(false)
    expect(api().onKey(key('Enter'))).toBe(false)
    expect(api().onKey(key('Tab'))).toBe(false)
    // Тот же отчёт (перерисовка без изменений) попап не возвращает.
    act(() => api().onReport(report('cd sr')))
    await tick(30)
    expect(api().state.open).toBe(false)
    act(() => api().onReport(report('cd s')))
    await tick(30)
    expect(api().state.open).toBe(true)
    expect(write).not.toHaveBeenCalled()
  })

  it("'end' closes the popup", async () => {
    listAlways()
    const { api } = setup()
    act(() => api().onReport(report('cd sr')))
    await tick(30)
    act(() => api().onReport('end'))
    expect(api().state.open).toBe(false)
    expect(api().onKey(key('ArrowDown'))).toBe(false)
  })

  it('ignores keys while closed and does not write', () => {
    const { api, write } = setup()
    expect(api().onKey(key('Enter'))).toBe(false)
    expect(api().onKey(key('Tab'))).toBe(false)
    expect(write).not.toHaveBeenCalled()
  })

  it('does not eat other keys, keyup or modified keys while open', async () => {
    listAlways()
    const { api, write } = setup()
    act(() => api().onReport(report('cd sr')))
    await tick(30)
    expect(api().onKey(key('a'))).toBe(false)
    expect(api().onKey(key('Enter', 'keyup'))).toBe(false)
    expect(api().onKey(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true }))).toBe(false)
    expect(write).not.toHaveBeenCalled()
  })

  it('stays closed when fs_list fails or the line is not a path argument', async () => {
    mocked.mockRejectedValue('Нет доступа')
    const { api } = setup()
    act(() => api().onReport(report('cd sr')))
    await tick(30)
    expect(api().state.open).toBe(false)
    act(() => api().onReport(report('echo sr')))
    await tick(30)
    expect(api().state.open).toBe(false)
  })

  it('stays closed when nothing matches', async () => {
    listAlways()
    const { api } = setup()
    act(() => api().onReport(report('cd zzz')))
    await tick(30)
    expect(api().state.open).toBe(false)
  })

  it('shows a preview error when fs_preview rejects', async () => {
    mocked.mockImplementation(async (cmd) => {
      if (cmd === 'fs_list') return ENTRIES
      throw 'boom'
    })
    const { api } = setup()
    act(() => api().onReport(report('cd sr')))
    await tick(30)
    await tick(80)
    expect(api().state.preview).toEqual({ kind: 'error', message: 'boom' })
  })

  it('a line-editing key typed past the popup invalidates ctx until the next report', async () => {
    listAlways()
    const { api, write } = setup()
    act(() => api().onReport(report('cd s')))
    await tick(30)
    expect(api().state.open).toBe(true)
    let eaten = true
    act(() => void (eaten = api().onKey(key('r'))))
    expect(eaten).toBe(false)
    expect(api().state.open).toBe(false)
    // Отчёт о `cd sr` ещё не пришёл — Tab уходит в zsh, ничего не пишем.
    expect(api().onKey(key('Tab'))).toBe(false)
    expect(write).not.toHaveBeenCalled()
    // Следующий отчёт открывает из кэша (без esc-блокировки, без нового fs_list).
    act(() => api().onReport(report('cd sr')))
    expect(api().state.open).toBe(true)
    expect(api().state.ctx?.token).toBe('sr')
    expect(mocked.mock.calls.filter((c) => c[0] === 'fs_list')).toHaveLength(1)
  })

  it.each(['Backspace', 'Delete', 'ArrowLeft', 'Home', 'End'])('%s closes the popup without eating', async (k) => {
    listAlways()
    const { api } = setup()
    act(() => api().onReport(report('cd s')))
    await tick(30)
    let eaten = true
    act(() => void (eaten = api().onKey(key(k))))
    expect(eaten).toBe(false)
    expect(api().state.open).toBe(false)
  })

  it('Shift+letter and Ctrl-combos also invalidate; bare modifiers do not', async () => {
    listAlways()
    const { api } = setup()
    act(() => api().onReport(report('cd s')))
    await tick(30)
    act(() => void api().onKey(new KeyboardEvent('keydown', { key: 'Shift', shiftKey: true })))
    expect(api().state.open).toBe(true)
    act(() => void api().onKey(new KeyboardEvent('keydown', { key: 'R', shiftKey: true })))
    expect(api().state.open).toBe(false)
    act(() => api().onReport(report('cd sR')))
    act(() => api().onReport(report('cd s')))
    expect(api().state.open).toBe(true)
    act(() => void api().onKey(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true })))
    expect(api().state.open).toBe(false)
  })

  it('ignores keys during IME composition', async () => {
    listAlways()
    const { api, write } = setup()
    act(() => api().onReport(report('cd s')))
    await tick(30)
    expect(api().onKey(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true }))).toBe(false)
    expect(api().onKey(new KeyboardEvent('keydown', { key: 'Tab', keyCode: 229 }))).toBe(false)
    expect(api().state.open).toBe(true)
    expect(write).not.toHaveBeenCalled()
  })

  it('↵ with an empty name and no arrow navigation goes to the shell', async () => {
    listAlways()
    const { api, write } = setup()
    act(() => api().onReport(report('cd ')))
    await tick(30)
    let eaten = true
    act(() => void (eaten = api().onKey(key('Enter'))))
    expect(eaten).toBe(false)
    expect(api().state.open).toBe(false)
    expect(write).not.toHaveBeenCalled()
  })

  it('↵ with an empty name after ↓ substitutes the chosen entry', async () => {
    listAlways()
    const { api, write } = setup()
    act(() => api().onReport(report('cd ')))
    await tick(30)
    act(() => void api().onKey(key('ArrowDown')))
    let eaten = false
    act(() => void (eaten = api().onKey(key('Enter'))))
    expect(eaten).toBe(true)
    expect(write).toHaveBeenCalledWith('scripts\r')
  })

  it.each([
    ['cd src', [dir('src'), dir('src2')]],
    ['cat README.md', [file('README.md'), file('README.md.bak')]],
  ] as const)('↵ is not consumed when the token already equals the entry (%s)', async (line, entries) => {
    listAlways([...entries])
    const { api, write } = setup()
    act(() => api().onReport(report(line)))
    await tick(30)
    expect(api().state.open).toBe(true)
    let eaten = true
    act(() => void (eaten = api().onKey(key('Enter'))))
    expect(eaten).toBe(false)
    expect(api().state.open).toBe(false)
    expect(write).not.toHaveBeenCalled()
  })
})
