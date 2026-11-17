// Выход из приложения (⌘Q, закрытие окна): Rust шлёт `app://before-exit` и ждёт до 2 с ответа
// `app_exit_ready`. За это время — последняя запись сессии и отложенных настроек.
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { flushSettings } from '../settings/store'
import { finalSave } from './session'

export const BEFORE_EXIT_EVENT = 'app://before-exit'

/** Дописывает сессию и настройки; `app_exit_ready` уходит всегда, даже если запись упала. */
export async function prepareExit(): Promise<void> {
  try {
    await Promise.all([finalSave(), flushSettings()])
  } finally {
    try {
      await invoke('app_exit_ready')
    } catch {
      // вне Tauri или окно уже закрывается — Rust выйдет по своему таймауту
    }
  }
}

/**
 * Подписка на событие выхода, затем `window_ready`: окно готово ответить на выход и принимать
 * вкладки (слушатель `tab://receive` ставит bootWindow раньше). До этого Rust окно не ждёт при
 * выходе и вкладок ему не передаёт. Возвращает отписку.
 */
export async function installExitHandler(): Promise<() => void> {
  const off = await listen(BEFORE_EXIT_EVENT, () => void prepareExit())
  try {
    await invoke('window_ready')
  } catch {
    // вне Tauri
  }
  return off
}
