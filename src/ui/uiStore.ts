import { create } from 'zustand'

interface UiState {
  settingsOpen: boolean
  setSettingsOpen(open: boolean): void
  /** ⌘J: панель агентов скрыта (во всех панелях). */
  agentsHidden: boolean
  toggleAgents(): void
}

export const useUi = create<UiState>((set) => ({
  settingsOpen: false,
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  agentsHidden: false,
  toggleAgents: () => set((s) => ({ agentsHidden: !s.agentsHidden })),
}))
