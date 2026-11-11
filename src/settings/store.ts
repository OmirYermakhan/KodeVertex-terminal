import { invoke } from '@tauri-apps/api/core'
import { create } from 'zustand'
import { applyTheme } from '../theme/applyTheme'
import { THEMES } from '../theme/themes'
import { normalizeSettings, type Settings } from './settings'

const SAVE_DELAY_MS = 300

interface SettingsState {
  settings: Settings
  loaded: boolean
  load: () => Promise<void>
  update: (patch: Partial<Settings>) => void
}

let saveTimer: ReturnType<typeof setTimeout> | undefined

function apply(s: Settings): void {
  applyTheme(THEMES[s.theme], s)
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: normalizeSettings(undefined),
  loaded: false,
  async load() {
    let raw: unknown = null
    try {
      raw = await invoke('settings_load')
    } catch {
      raw = null
    }
    const settings = normalizeSettings(raw)
    apply(settings)
    set({ settings, loaded: true })
  },
  update(patch) {
    const settings = normalizeSettings({ ...get().settings, ...patch })
    apply(settings)
    set({ settings })
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      invoke('settings_save', { value: get().settings }).catch(() => {})
    }, SAVE_DELAY_MS)
  },
}))
