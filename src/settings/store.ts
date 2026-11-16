import { invoke } from '@tauri-apps/api/core'
import { create } from 'zustand'
import { applyTheme } from '../theme/applyTheme'
import { THEMES } from '../theme/themes'
import { normalizeSettings, withUnknownFields, type Settings } from './settings'

const SAVE_DELAY_MS = 300

export const CORRUPT_NOTICE = 'settings.toml повреждён — копия в settings.toml.bak'

interface SettingsState {
  settings: Settings
  loaded: boolean
  /** Ошибка чтения settings.toml (файл повреждён): работаем на значениях по умолчанию. */
  loadError: string | null
  load: () => Promise<void>
  update: (patch: Partial<Settings>) => void
}

let saveTimer: ReturnType<typeof setTimeout> | undefined
/** Сырой объект из файла: незнакомые ключи (новые версии, ручные правки) уходят обратно при записи. */
let rawLoaded: unknown = null

function apply(s: Settings): void {
  applyTheme(THEMES[s.theme], s)
}

function save(): Promise<void> {
  return invoke('settings_save', { value: withUnknownFields(rawLoaded, useSettings.getState().settings) })
    .then(() => {})
    .catch(() => {})
}

/** Тост об испорченном файле — лениво: notify сам импортирует этот модуль. */
function showCorruptNotice(): void {
  void import('../notify/notify')
    .then((m) => m.useToasts.getState().push({ kind: 'error', text: CORRUPT_NOTICE, paneId: '', agentId: null }))
    .catch(() => {})
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: normalizeSettings(undefined),
  loaded: false,
  loadError: null,
  async load() {
    let raw: unknown = null
    let loadError: string | null = null
    try {
      raw = await invoke('settings_load')
    } catch (e) {
      // Файл не разобрался (Rust уже положил копию в settings.toml.bak): значения по умолчанию, но
      // ничего не записываем, пока пользователь сам не поменяет настройку.
      raw = null
      loadError = typeof e === 'string' ? e : String(e)
      console.error(`[settings] ${loadError}`)
      showCorruptNotice()
    }
    rawLoaded = raw
    const settings = normalizeSettings(raw)
    apply(settings)
    set({ settings, loaded: true, loadError })
  },
  update(patch) {
    const settings = normalizeSettings({ ...get().settings, ...patch })
    apply(settings)
    set({ settings })
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = undefined
      void save()
    }, SAVE_DELAY_MS)
  },
}))

/** Отложенная запись настроек — сразу (выход из приложения). Ничего не ждёт — ничего не пишет. */
export function flushSettings(): Promise<void> {
  if (saveTimer === undefined) return Promise.resolve()
  clearTimeout(saveTimer)
  saveTimer = undefined
  return save()
}

/** Только для тестов: сбросить состояние модуля. */
export function __resetSettingsModule(): void {
  clearTimeout(saveTimer)
  saveTimer = undefined
  rawLoaded = null
}
