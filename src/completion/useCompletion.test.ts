import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { useCompletion, type FsEntryTS } from './useCompletion'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

const mocked = vi.mocked(invoke)

const dir = (name: string): FsEntryTS => ({ name, isDir: true, isSymlink: false })
const file = (name: string): FsEntryTS => ({ name, isDir: false, isSymlink: false })
const ENTRIES = [dir('docs'), dir('src'), dir('scripts')]

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

const key = (k: string, o: KeyboardEventInit = {}, type = 'keydown') => new KeyboardEvent(type, { key: k, ...o })

function setup(cwd = '/p') {
  const replace = vi.fn()
  const hook = renderHook(() => useCompletion({ cwd: () => cwd, home: '/h', replace }))
  const api = () => hook.result.current
  /** Строка с курсором в конце. */
  const line = (buffer: string, typed = true) => act(() => api().update(buffer, buffer.length, typed))
  return { replace, hook, api, line }
}

/** fs_list отвечает entries, fs_preview — пустым каталогом. */
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

const press = (api: () => { onKey(e: KeyboardEvent): boolean }, k: string, o: KeyboardEventInit = {}) => {
  let eaten = false
  act(() => void (eaten = api().onKey(key(k, o))))
  return eaten
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
    const { api, line } = setup()
    line('cd sr')
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
    const { api, line } = setup()
    line('cd s')
    await tick(30)
    line('cd sr')
    await tick(30)
    await act(async () => second.resolve([dir('src'), dir('sr2')]))
    expect(api().state.items.map((i) => i.name)).toEqual(['sr2', 'src'])
    await act(async () => first.resolve([dir('stale')]))
    expect(api().state.items.map((i) => i.name)).toEqual(['sr2', 'src'])
  })

  it('reuses the cached listing while the directory stays the same; reset drops the cache', async () => {
    listAlways()
    const { api, line } = setup()
    line('cd s')
    await tick(30)
    line('cd sc')
    expect(api().state.items[0].name).toBe('scripts')
    expect(mocked.mock.calls.filter((c) => c[0] === 'fs_list')).toHaveLength(1)
    act(() => api().reset())
    expect(api().state.open).toBe(false)
    line('cd s')
    await tick(30)
    expect(mocked.mock.calls.filter((c) => c[0] === 'fs_list')).toHaveLength(2)
  })

  it('cycles the selection with ↓ / ↑ and loads the preview of the highlighted entry', async () => {
    listAlways()
    const { api, line } = setup()
    line('cd ')
    await tick(30)
    expect(api().state.items.map((i) => i.name)).toEqual(['docs', 'scripts', 'src'])
    expect(press(api, 'ArrowDown')).toBe(true)
    expect(api().state.selected).toBe(1)
    expect(api().state.navigated).toBe(true)
    press(api, 'ArrowUp')
    press(api, 'ArrowUp')
    expect(api().state.selected).toBe(2)
    await tick(80)
    expect(mocked).toHaveBeenLastCalledWith('fs_preview', { path: '/p/src' })
    expect(api().state.preview).toEqual({ kind: 'dir', entries: [], total: 0 })
  })

  it('Tab: `cd Док` → value `cd Документы/`, cursor at the end', async () => {
    listAlways([dir('Документы'), dir('Загрузки')])
    const { api, line, replace } = setup()
    line('cd Док')
    await tick(30)
    expect(press(api, 'Tab')).toBe(true)
    expect(replace).toHaveBeenCalledWith('cd Документы/', 13, false)
    expect(api().state.open).toBe(false)
  })

  it('Tab with an empty name substitutes the first entry (no shell Tab to fall back to)', async () => {
    listAlways()
    const { api, line, replace } = setup()
    line('cd ')
    await tick(30)
    expect(press(api, 'Tab')).toBe(true)
    expect(replace).toHaveBeenCalledWith('cd docs/', 8, false)
  })

  it('→ substitutes like Tab', async () => {
    listAlways()
    const { api, line, replace } = setup()
    line('cd sr')
    await tick(30)
    expect(press(api, 'ArrowRight')).toBe(true)
    expect(replace).toHaveBeenCalledWith('cd src/', 7, false)
  })

  it('↵ on cd substitutes without the trailing slash and runs', async () => {
    listAlways()
    const { api, line, replace } = setup()
    line('cd sr')
    await tick(30)
    expect(press(api, 'Enter')).toBe(true)
    expect(replace).toHaveBeenCalledTimes(1)
    expect(replace).toHaveBeenCalledWith('cd src', 6, true)
    expect(api().state.open).toBe(false)
  })

  it('↵ on other commands without ↑/↓ is not eaten (the line runs as typed)', async () => {
    listAlways([file('README.md')])
    const { api, line, replace } = setup()
    line('cat READ')
    await tick(30)
    expect(mocked).toHaveBeenCalledWith('fs_list', { dir: '/p', dirsOnly: false, includeHidden: false })
    expect(press(api, 'Enter')).toBe(false)
    expect(api().state.open).toBe(false)
    expect(replace).not.toHaveBeenCalled()
  })

  it('↵ on other commands after ↑/↓ only substitutes', async () => {
    listAlways([file('README.md'), file('READ.txt')])
    const { api, line, replace } = setup()
    line('cat READ')
    await tick(30)
    expect(api().state.items.map((i) => i.name)).toEqual(['READ.txt', 'README.md'])
    press(api, 'ArrowDown')
    expect(press(api, 'Enter')).toBe(true)
    expect(replace).toHaveBeenCalledWith('cat README.md', 13, false)
  })

  it('↵ with an empty cd name: without ↑/↓ runs as typed, after ↓ goes to the entry', async () => {
    listAlways()
    const { api, line, replace } = setup()
    line('cd ')
    await tick(30)
    expect(press(api, 'Enter')).toBe(false)
    expect(replace).not.toHaveBeenCalled()
    line('cd  ')
    line('cd ')
    press(api, 'ArrowDown')
    expect(press(api, 'Enter')).toBe(true)
    expect(replace).toHaveBeenCalledWith('cd scripts', 10, true)
  })

  it.each([
    ['cd src', [dir('src'), dir('src2')]],
    ['cat README.md', [file('README.md'), file('README.md.bak')]],
  ] as const)('↵ is not consumed when the token already equals the entry (%s)', async (text, entries) => {
    listAlways([...entries])
    const { api, line, replace } = setup()
    line(text)
    await tick(30)
    expect(api().state.open).toBe(true)
    expect(press(api, 'Enter')).toBe(false)
    expect(api().state.open).toBe(false)
    expect(replace).not.toHaveBeenCalled()
  })

  it('a recalled (not typed) line does not open the popup', async () => {
    listAlways()
    const { api, line } = setup()
    line('cd sr', false)
    await tick(30)
    expect(api().state.open).toBe(false)
    expect(mocked).not.toHaveBeenCalled()
    // Повтор той же строки (onSelect) тоже не открывает; набор — открывает.
    act(() => api().update('cd sr', 5))
    await tick(30)
    expect(api().state.open).toBe(false)
    line('cd s')
    await tick(30)
    expect(api().state.open).toBe(true)
  })

  it('multi-line input: context and substitution use the cursor line', async () => {
    listAlways()
    const { api, replace } = setup()
    act(() => api().update('echo a\ncd sr\nls', 12))
    await tick(30)
    expect(api().state.open).toBe(true)
    expect(api().state.ctx?.token).toBe('sr')
    press(api, 'Tab')
    expect(replace).toHaveBeenCalledWith('echo a\ncd src/\nls', 14, false)
  })

  it('cursor inside the token closes', async () => {
    listAlways()
    const { api, line } = setup()
    line('cd sr')
    await tick(30)
    expect(api().state.open).toBe(true)
    act(() => api().update('cd sr', 4))
    expect(api().state.open).toBe(false)
  })

  it('a buffer over 4096 chars closes and is not processed', async () => {
    listAlways()
    const { api, line } = setup()
    line('cd s')
    await tick(30)
    expect(api().state.open).toBe(true)
    line('cd ' + 'a '.repeat(2500) + 's')
    await tick(30)
    expect(api().state.open).toBe(false)
    expect(mocked.mock.calls.filter((c) => c[0] === 'fs_list')).toHaveLength(1)
  })

  it('esc closes and eats; the same line stays closed until it changes', async () => {
    listAlways()
    const { api, line, replace } = setup()
    line('cd sr')
    await tick(30)
    expect(press(api, 'Escape')).toBe(true)
    expect(api().state.open).toBe(false)
    expect(press(api, 'Enter')).toBe(false)
    expect(press(api, 'Tab')).toBe(false)
    act(() => api().update('cd sr', 5))
    await tick(30)
    expect(api().state.open).toBe(false)
    line('cd s')
    await tick(30)
    expect(api().state.open).toBe(true)
    expect(replace).not.toHaveBeenCalled()
  })

  it('ignores keys while closed', () => {
    const { api, replace } = setup()
    expect(press(api, 'Enter')).toBe(false)
    expect(press(api, 'Tab')).toBe(false)
    expect(replace).not.toHaveBeenCalled()
  })

  it('does not eat other keys, keyup or modified keys while open', async () => {
    listAlways()
    const { api, line, replace } = setup()
    line('cd sr')
    await tick(30)
    expect(press(api, 'a')).toBe(false)
    let eaten = true
    act(() => void (eaten = api().onKey(key('Enter', {}, 'keyup'))))
    expect(eaten).toBe(false)
    expect(press(api, 'Tab', { shiftKey: true })).toBe(false)
    expect(press(api, 'Enter', { metaKey: true })).toBe(false)
    expect(replace).not.toHaveBeenCalled()
  })

  it('stays closed when fs_list fails or the line is not a path argument', async () => {
    mocked.mockRejectedValue('Нет доступа')
    const { api, line } = setup()
    line('cd sr')
    await tick(30)
    expect(api().state.open).toBe(false)
    line('echo sr')
    await tick(30)
    expect(api().state.open).toBe(false)
  })

  it('stays closed when nothing matches', async () => {
    listAlways()
    const { api, line } = setup()
    line('cd zzz')
    await tick(30)
    expect(api().state.open).toBe(false)
  })

  it('shows a preview error when fs_preview rejects', async () => {
    mocked.mockImplementation(async (cmd) => {
      if (cmd === 'fs_list') return ENTRIES
      throw 'boom'
    })
    const { api, line } = setup()
    line('cd sr')
    await tick(30)
    await tick(80)
    expect(api().state.preview).toEqual({ kind: 'error', message: 'boom' })
  })

  it('ignores keys during IME composition', async () => {
    listAlways()
    const { api, line, replace } = setup()
    line('cd s')
    await tick(30)
    expect(press(api, 'Enter', { isComposing: true })).toBe(false)
    expect(press(api, 'Tab', { keyCode: 229 })).toBe(false)
    expect(api().state.open).toBe(true)
    expect(replace).not.toHaveBeenCalled()
  })
})
