import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))

import { __resetSettingsModule, flushSettings, useSettings } from './store'
import { DEFAULTS } from './settings'

describe('useSettings', () => {
  beforeEach(() => {
    invoke.mockReset()
    vi.useFakeTimers()
    __resetSettingsModule()
    useSettings.setState({ settings: DEFAULTS, loaded: false, loadError: null })
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

  it('повреждённый файл: значения по умолчанию, ошибка в loadError, ничего не пишется до правки', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    invoke.mockRejectedValueOnce('TOML parse error')
    await useSettings.getState().load()
    expect(useSettings.getState().settings).toEqual(DEFAULTS)
    expect(useSettings.getState().loadError).toBe('TOML parse error')
    expect(err).toHaveBeenCalled()
    vi.advanceTimersByTime(5000)
    await flushSettings()
    expect(invoke.mock.calls.some((c) => c[0] === 'settings_save')).toBe(false)
    // Явная правка пользователя — запись разрешена (копия уже в .bak).
    invoke.mockResolvedValue(undefined)
    useSettings.getState().update({ theme: 'kv' })
    vi.advanceTimersByTime(300)
    expect(invoke).toHaveBeenCalledWith('settings_save', { value: { ...DEFAULTS, theme: 'kv' } })
    err.mockRestore()
  })

  it('незнакомые ключи файла сохраняются при записи', async () => {
    invoke.mockResolvedValueOnce({ theme: 'kv', futureKey: { a: 1 }, launchers: [] })
    await useSettings.getState().load()
    invoke.mockResolvedValue(undefined)
    useSettings.getState().update({ textSize: 20 })
    vi.advanceTimersByTime(300)
    expect(invoke).toHaveBeenLastCalledWith('settings_save', {
      value: { ...DEFAULTS, theme: 'kv', textSize: 20, futureKey: { a: 1 } },
    })
  })

  it('flushSettings пишет отложенное сразу и ждёт записи', async () => {
    invoke.mockResolvedValue(undefined)
    useSettings.getState().update({ theme: 'kv' })
    await flushSettings()
    expect(invoke).toHaveBeenCalledWith('settings_save', { value: { ...DEFAULTS, theme: 'kv' } })
    vi.advanceTimersByTime(300)
    expect(invoke).toHaveBeenCalledTimes(1)
  })
})
