import { create } from 'zustand'
import { closePane, leaf, leaves, neighbor, setRatioAt, splitPane, type Dir, type PaneNode } from './paneTree'

export interface Tab {
  id: string
  tree: PaneNode
  focused: string
  cwd: Record<string, string>
}

interface TabsState {
  tabs: Tab[]
  active: string
  newTab(cwd?: string): void
  closeTab(id: string): void
  activate(id: string): void
  activateIndex(i: number): void
  split(axis: 'row' | 'col'): void
  closeFocused(): void
  paneExited(paneId: string): void
  focusDir(dir: Dir): void
  focus(paneId: string): void
  setCwd(paneId: string, cwd: string): void
  setRatio(tabId: string, path: ('a' | 'b')[], ratio: number): void
}

function makeTab(cwd?: string): Tab {
  const id = crypto.randomUUID()
  return { id, tree: leaf(id), focused: id, cwd: cwd ? { [id]: cwd } : {} }
}

export function initialTabsState(): Pick<TabsState, 'tabs' | 'active'> {
  const t = makeTab()
  return { tabs: [t], active: t.id }
}

const mapTab = (s: TabsState, id: string, fn: (t: Tab) => Tab): Tab[] => s.tabs.map((t) => (t.id === id ? fn(t) : t))

/** Удаляет панель; если вкладка опустела — закрывает её. */
function removePane(s: TabsState, tab: Tab, paneId: string): Partial<TabsState> {
  const tree = closePane(tab.tree, paneId)
  if (!tree) return removeTab(s, tab.id)
  const order = leaves(tab.tree)
  const rest = leaves(tree)
  let focused = tab.focused
  if (focused === paneId) {
    const i = order.indexOf(paneId)
    focused = neighbor(tab.tree, paneId, 'left') ?? neighbor(tab.tree, paneId, 'up') ??
      rest[Math.min(i, rest.length - 1)]
    if (!rest.includes(focused)) focused = rest[0]
  }
  const cwd = { ...tab.cwd }
  delete cwd[paneId]
  return { tabs: mapTab(s, tab.id, () => ({ ...tab, tree, focused, cwd })) }
}

function removeTab(s: TabsState, id: string): Partial<TabsState> {
  const i = s.tabs.findIndex((t) => t.id === id)
  if (i < 0) return {}
  const tabs = s.tabs.filter((t) => t.id !== id)
  if (tabs.length === 0) return initialTabsState()
  const active = s.active === id ? tabs[Math.min(i, tabs.length - 1)].id : s.active
  return { tabs, active }
}

export const useTabs = create<TabsState>((set) => ({
  ...initialTabsState(),
  newTab: (cwd) =>
    set((s) => {
      const t = makeTab(cwd)
      return { tabs: [...s.tabs, t], active: t.id }
    }),
  closeTab: (id) => set((s) => removeTab(s, id)),
  activate: (id) => set((s) => (s.tabs.some((t) => t.id === id) ? { active: id } : {})),
  activateIndex: (i) =>
    set((s) => (i >= 0 && i < s.tabs.length ? { active: s.tabs[i].id } : {})),
  split: (axis) =>
    set((s) => {
      const tab = s.tabs.find((t) => t.id === s.active)
      if (!tab) return {}
      const id = crypto.randomUUID()
      const inherited = tab.cwd[tab.focused]
      return {
        tabs: mapTab(s, tab.id, (t) => ({
          ...t,
          tree: splitPane(t.tree, t.focused, axis, id),
          focused: id,
          cwd: inherited ? { ...t.cwd, [id]: inherited } : t.cwd,
        })),
      }
    }),
  closeFocused: () =>
    set((s) => {
      const tab = s.tabs.find((t) => t.id === s.active)
      return tab ? removePane(s, tab, tab.focused) : {}
    }),
  paneExited: (paneId) =>
    set((s) => {
      const tab = s.tabs.find((t) => leaves(t.tree).includes(paneId))
      return tab ? removePane(s, tab, paneId) : {}
    }),
  focusDir: (dir) =>
    set((s) => {
      const tab = s.tabs.find((t) => t.id === s.active)
      const to = tab && neighbor(tab.tree, tab.focused, dir)
      return tab && to ? { tabs: mapTab(s, tab.id, (t) => ({ ...t, focused: to })) } : {}
    }),
  focus: (paneId) =>
    set((s) => {
      const tab = s.tabs.find((t) => leaves(t.tree).includes(paneId))
      if (!tab || (tab.focused === paneId && s.active === tab.id)) return {}
      return { tabs: mapTab(s, tab.id, (t) => ({ ...t, focused: paneId })), active: tab.id }
    }),
  setCwd: (paneId, cwd) =>
    set((s) => {
      const tab = s.tabs.find((t) => leaves(t.tree).includes(paneId))
      if (!tab || tab.cwd[paneId] === cwd) return {}
      return { tabs: mapTab(s, tab.id, (t) => ({ ...t, cwd: { ...t.cwd, [paneId]: cwd } })) }
    }),
  setRatio: (tabId, path, ratio) =>
    set((s) => ({
      tabs: mapTab(s, tabId, (t) => ({ ...t, tree: setRatioAt(t.tree, path, Math.min(0.85, Math.max(0.15, ratio))) })),
    })),
}))
