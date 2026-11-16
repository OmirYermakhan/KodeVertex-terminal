import { create } from 'zustand'

interface UiState {
  settingsOpen: boolean
  setSettingsOpen(open: boolean): void
  /** ⌘P: палитра команд открыта. */
  paletteOpen: boolean
  setPaletteOpen(open: boolean): void
  /** ⌘J: панель агентов скрыта (во всех панелях). */
  agentsHidden: boolean
  toggleAgents(): void
  /** Клик по тосту: выбрать агента в панели агентов этой панели. */
  agentRequest: { paneId: string; agentId: string} | null
  requestAgent(paneId: string, agentId: string): void
  clearAgentRequest(): void
  /** Окно быстрого входа: { id: null } — новый, иначе правка; null — закрыто. */
  launcherEdit: { id: string | null } | null
  setLauncherEdit(v: { id: string | null } | null): void
}

export const useUi = create<UiState>((set) => ({
  settingsOpen: false,
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  paletteOpen: false,
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  agentsHidden: false,
  toggleAgents: () => set((s) => ({ agentsHidden: !s.agentsHidden })),
  agentRequest: null,
  requestAgent: (paneId, agentId) => set({ agentRequest: { paneId, agentId }, agentsHidden: false }),
  clearAgentRequest: () => set({ agentRequest: null }),
  launcherEdit: null,
  setLauncherEdit: (launcherEdit) => set({ launcherEdit }),
}))
