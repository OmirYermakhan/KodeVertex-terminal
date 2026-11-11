import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { useGitInfo, type GitInfo } from './useGitInfo'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/path', () => ({ homeDir: () => Promise.resolve('/h') }))

const mocked = vi.mocked(invoke)
const info = (branch: string): GitInfo => ({ root: '/r', branch, dirty: false })

function deferred() {
  let resolve!: (v: GitInfo) => void
  const promise = new Promise<GitInfo>((r) => (resolve = r))
  return { promise, resolve }
}

describe('useGitInfo', () => {
  let focused = true
  beforeEach(() => {
    vi.useFakeTimers()
    focused = true
    vi.spyOn(document, 'hasFocus').mockImplementation(() => focused)
    mocked.mockReset()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('polls every 5 s and stops after unmount', async () => {
    mocked.mockResolvedValue(info('main'))
    const { unmount, result } = renderHook(() => useGitInfo('/a'))
    await act(async () => {})
    expect(result.current?.branch).toBe('main')
    expect(mocked).toHaveBeenCalledTimes(1)
    await act(async () => void vi.advanceTimersByTime(5000))
    expect(mocked).toHaveBeenCalledTimes(2)
    unmount()
    await act(async () => void vi.advanceTimersByTime(20000))
    expect(mocked).toHaveBeenCalledTimes(2)
  })

  it('does not poll while the window is unfocused', async () => {
    mocked.mockResolvedValue(info('main'))
    renderHook(() => useGitInfo('/a'))
    await act(async () => {})
    focused = false
    await act(async () => void vi.advanceTimersByTime(20000))
    expect(mocked).toHaveBeenCalledTimes(1)
  })

  it('does not start a call while one is in flight', async () => {
    const d = deferred()
    mocked.mockReturnValue(d.promise)
    renderHook(() => useGitInfo('/a'))
    await act(async () => void vi.advanceTimersByTime(15000))
    expect(mocked).toHaveBeenCalledTimes(1)
    await act(async () => d.resolve(info('main')))
    await act(async () => void vi.advanceTimersByTime(5000))
    expect(mocked).toHaveBeenCalledTimes(2)
  })

  it('drops a stale response after cwd changed and clears the old interval', async () => {
    const first = deferred()
    mocked.mockReturnValueOnce(first.promise).mockResolvedValue(info('new'))
    const { result, rerender } = renderHook(({ c }) => useGitInfo(c), { initialProps: { c: '/a' } })
    rerender({ c: '/b' })
    await act(async () => {})
    expect(result.current?.branch).toBe('new')
    await act(async () => first.resolve(info('old')))
    expect(result.current?.branch).toBe('new')
    mocked.mockClear()
    await act(async () => void vi.advanceTimersByTime(5000))
    expect(mocked).toHaveBeenCalledTimes(1)
    expect(mocked).toHaveBeenCalledWith('git_info', { cwd: '/b' })
  })
})
