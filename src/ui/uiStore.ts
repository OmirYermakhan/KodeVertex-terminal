import { create } from 'zustand'

interface UiState {
  settingsOpen: boolean
  setSettingsOpen(open: boolean): void
  /** ⌘J: панель агентов скрыта (во всех панелях). */
  agentsHidden: boolean
  toggleAgents(): void
  /** Клик по тосту: выбрать агента в панели агентов этой панели. */
  agentRequest: { paneId: string; agentId: string; nonce: number } | null
  requestAgent(paneId: string, agentId: string): void
  clearAgentRequest(): void
}

export const useUi = create<UiState>((set) => ({
  settingsOpen: false,
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  agentsHidden: false,
  toggleAgents: () => set((s) => ({ agentsHidden: !s.agentsHidden })),
  agentRequest: null,
  requestAgent: (paneId, agentId) => set({ agentRequest: { paneId, agentId, nonce: Date.now() }, agentsHidden: false }),
  clearAgentRequest: () => set({ agentRequest: null }),
}))
