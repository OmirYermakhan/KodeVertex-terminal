// Запуск быстрого входа в его вкладке: панели регистрируют, как в них выполнить команду и идёт ли
// в них что-то сейчас; команда для ещё не готовой панели ждёт её первого приглашения.
import { create } from 'zustand'
import { leaves } from '../layout/paneTree'
import { useTabs, type Tab } from '../layout/tabsStore'
import { useSettings } from '../settings/store'
import type { Launcher } from './launchers'

export interface PaneRunner {
  /** Очистить ленту и выполнить команду; false — оболочка ещё не готова. */
  run(command: string): boolean
  /** В панели идёт команда (сессия на сервере жива) или открыт Claude — команду не повторять. */
  busy(): boolean
}

const runners = new Map<string, PaneRunner>()
/** Команды для панелей, чья оболочка ещё не показала приглашение. */
const pending = new Map<string, string>()

export function registerPaneRunner(paneId: string, r: PaneRunner): () => void {
  runners.set(paneId, r)
  return () => {
    if (runners.get(paneId) === r) runners.delete(paneId)
  }
}

/** Панель готова (первое приглашение): забрать ждущую её команду. */
export function takePending(paneId: string): string | null {
  const cmd = pending.get(paneId) ?? null
  pending.delete(paneId)
  return cmd
}

/** Идёт ли команда в панели — для точки «подключено» у значка входа. */
interface RunningState {
  running: Record<string, boolean>
  set(paneId: string, v: boolean): void
}
export const usePaneRunning = create<RunningState>((set) => ({
  running: {},
  set: (paneId, v) =>
    set((s) => {
      if (!!s.running[paneId] === v) return {}
      const running = { ...s.running }
      if (v) running[paneId] = true
      else delete running[paneId]
      return { running }
    }),
}))

/** Панель входа во вкладке: первая (id вкладки), если её не закрыли, иначе панель в фокусе. */
export function launcherPane(t: Tab): string {
  return leaves(t.tree).includes(t.id) ? t.id : t.focused
}

export function launcherTab(tabs: readonly Tab[], id: string): Tab | undefined {
  return tabs.find((t) => t.launcher === id)
}

/**
 * Клик по входу: вкладки нет — новая с командой; есть и команда идёт — только переключиться;
 * есть, но с сервера вышли (оболочка в простое) — лента очищается и команда запускается снова.
 */
export function openLauncher(l: Launcher): void {
  const s = useTabs.getState()
  const tab = launcherTab(s.tabs, l.id)
  if (!tab) {
    const cur = s.tabs.find((t) => t.id === s.active)
    const id = s.newTab(l.cwd ?? cur?.cwd[cur.focused], l.id)
    if (l.command !== '') pending.set(id, l.command)
    return
  }
  s.activate(tab.id)
  const pane = launcherPane(tab)
  if (tab.focused !== pane) s.focus(pane)
  if (l.command === '') return
  const r = runners.get(pane)
  if (!r) {
    pending.set(pane, l.command)
    return
  }
  if (r.busy()) return
  if (!r.run(l.command)) pending.set(pane, l.command)
}

export function openLauncherById(id: string): void {
  const l = useSettings.getState().settings.launchers.find((x) => x.id === id)
  if (l) openLauncher(l)
}

/** Только для тестов. */
export function resetRunnersForTest(): void {
  runners.clear()
  pending.clear()
  usePaneRunning.setState({ running: {} })
}
