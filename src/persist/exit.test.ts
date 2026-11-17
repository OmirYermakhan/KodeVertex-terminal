import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
const listeners = new Map<string, () => void>()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: (name: string, cb: () => void) => {
    listeners.set(name, cb)
    return Promise.resolve(() => listeners.delete(name))
  },
}))

const { BEFORE_EXIT_EVENT, installExitHandler, prepareExit } = await import('./exit')
const { resetPersistForTests } = await import('./session')
const { useSettings, __resetSettingsModule } = await import('../settings/store')

const order = () => invoke.mock.calls.map((c) => c[0])

describe('выход из приложения', () => {
  beforeEach(() => {
    resetPersistForTests()
    __resetSettingsModule()
    invoke.mockReset()
    listeners.clear()
  })

  it('сначала записи сессии и отложенных настроек, потом app_exit_ready', async () => {
    let release!: () => void
    invoke.mockImplementation((cmd: string) =>
      cmd === 'session_save' ? new Promise<void>((r) => (release = r)) : Promise.resolve(undefined),
    )
    useSettings.getState().update({ theme: 'kv' })
    await installExitHandler()
    listeners.get(BEFORE_EXIT_EVENT)!()
    await Promise.resolve()
    expect(order()).toContain('session_save')
    expect(order()).toContain('settings_save')
    expect(order()).not.toContain('app_exit_ready')
    release()
    await new Promise((r) => setTimeout(r, 0))
    expect(order().at(-1)).toBe('app_exit_ready')
  })

  it('после подписки на выход — window_ready (Rust ждёт при выходе только готовые окна)', async () => {
    invoke.mockResolvedValue(undefined)
    await installExitHandler()
    expect(listeners.has(BEFORE_EXIT_EVENT)).toBe(true)
    expect(order()).toEqual(['window_ready'])
    // Вне Tauri window_ready падает — подписка всё равно есть.
    invoke.mockRejectedValue(new Error('нет tauri'))
    listeners.clear()
    await expect(installExitHandler()).resolves.toBeTypeOf('function')
    expect(listeners.has(BEFORE_EXIT_EVENT)).toBe(true)
  })

  it('app_exit_ready уходит, даже если запись упала', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'settings_save') throw new Error('диск')
      return cmd === 'session_save' ? Promise.reject(new Error('диск')) : Promise.resolve(undefined)
    })
    useSettings.getState().update({ theme: 'kv' })
    await prepareExit().catch(() => {})
    expect(order().at(-1)).toBe('app_exit_ready')
  })
})
