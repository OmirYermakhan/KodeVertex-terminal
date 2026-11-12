import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))

const { getHistory, historyStep, loadHistory, NAV_START, pushHistory, resetHistory } = await import('./history')

describe('history', () => {
  beforeEach(() => {
    invoke.mockReset()
    resetHistory()
  })

  it('загружает shell_history один раз; выполненные до загрузки команды остаются последними', async () => {
    invoke.mockResolvedValue(['ls', 'ls', 'git status'])
    pushHistory('pwd')
    await loadHistory()
    await loadHistory()
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('shell_history')
    expect(getHistory()).toEqual(['ls', 'git status', 'pwd'])
  })

  it('ошибка загрузки — пустая история, без исключения', async () => {
    invoke.mockRejectedValue('нет')
    await loadHistory()
    expect(getHistory()).toEqual([])
  })

  it('pushHistory пропускает пустые и повтор подряд', () => {
    pushHistory('a')
    pushHistory('a')
    pushHistory('  ')
    pushHistory('b')
    expect(getHistory()).toEqual(['a', 'b'])
  })

  it('historyStep: ↑ с черновика, вверх до первой, ↓ обратно к черновику', () => {
    const list = ['a', 'b', 'c']
    let s = historyStep(list, NAV_START, 'черн', 'up')!
    expect(s.value).toBe('c')
    s = historyStep(list, s.nav, s.value, 'up')!
    s = historyStep(list, s.nav, s.value, 'up')!
    expect(s.value).toBe('a')
    expect(historyStep(list, s.nav, s.value, 'up')).toBeNull()
    s = historyStep(list, s.nav, s.value, 'down')!
    s = historyStep(list, s.nav, s.value, 'down')!
    expect(s.value).toBe('c')
    s = historyStep(list, s.nav, s.value, 'down')!
    expect(s).toEqual({ nav: NAV_START, value: 'черн' })
    expect(historyStep(list, s.nav, s.value, 'down')).toBeNull()
    expect(historyStep([], NAV_START, '', 'up')).toBeNull()
  })
})
