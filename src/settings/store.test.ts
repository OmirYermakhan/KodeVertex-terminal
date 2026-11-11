import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))

import { useSettings } from './store'
import { DEFAULTS } from './settings'

describe('useSettings', () => {
  beforeEach(() => {
    invoke.mockReset()
    vi.useFakeTimers()
    useSettings.setState({ settings: DEFAULTS, loaded: false })
  })
  afterEach(() => vi.useRealTimers())

  it('load нормализует значения и ставит loaded', async () => {
    invoke.mockResolvedValue({ textSize: 99 })
    await useSettings.getState().load()
    expect(invoke).toHaveBeenCalledWith('settings_load')
    expect(useSettings.getState().settings.textSize).toBe(28)
    expect(useSettings.getState().loaded).toBe(true)
  })

  it('load без файла оставляет значения по умолчанию', async () => {
    invoke.mockResolvedValue(null)
    await useSettings.getState().load()
    expect(useSettings.getState().settings).toEqual(DEFAULTS)
    expect(useSettings.getState().loaded).toBe(true)
  })

  it('update дебаунсит сохранение на 300 мс', async () => {
    invoke.mockResolvedValue(undefined)
    useSettings.getState().update({ theme: 'kv' })
    vi.advanceTimersByTime(100)
    useSettings.getState().update({ textSize: 20 })
    vi.advanceTimersByTime(299)
    expect(invoke).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('settings_save', {
      value: { ...DEFAULTS, theme: 'kv', textSize: 20 },
    })
  })
})
