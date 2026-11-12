import { useEffect } from 'react'
import { useSettings } from './settings/store'
import { listen } from '@tauri-apps/api/event'
import { useTabs } from './layout/tabsStore'
import { runAction } from './keys/actions'
import { matchKey, type Action } from './keys/keymap'
import PaneView from './ui/PaneView'
import TabBar from './ui/TabBar'
import StatusBar from './ui/StatusBar'
import SettingsPanel from './ui/SettingsPanel'
import { useUi } from './ui/uiStore'
import { useGitInfo } from './status/useGitInfo'
import Toasts from './notify/Toasts'
import { installNotifications } from './notify/notify'
import { useClaudeSessions } from './claude/sessionStore'

const REPEATABLE = new Set<Action>(['fontBigger', 'fontSmaller'])

export default function App() {
  const loaded = useSettings((s) => s.loaded)
  const tabs = useTabs((s) => s.tabs)
  const active = useTabs((s) => s.active)
  const cwd = useTabs((s) => {
    const t = s.tabs.find((x) => x.id === s.active)
    return t?.cwd[t.focused]
  })
  const focusedPane = useTabs((s) => s.tabs.find((x) => x.id === s.active)?.focused)
  const git = useGitInfo(cwd)
  const claude = useClaudeSessions((s) => (focusedPane ? s.sessions[focusedPane]?.state : undefined))
  const settingsOpen = useUi((s) => s.settingsOpen)

  useEffect(() => {
    useSettings.getState().load()
  }, [])

  useEffect(() => installNotifications(), [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const a = matchKey(e)
      if (!a) return
      e.preventDefault()
      e.stopPropagation()
      // Автоповтор только для размера шрифта: зажатый ⌘W не должен закрыть всё подряд.
      if (e.repeat && !REPEATABLE.has(a)) return
      // Пока открыты настройки, остальные действия не должны менять вкладки за окном.
      if (useUi.getState().settingsOpen && a !== 'openSettings') return
      runAction(a)
    }
    window.addEventListener('keydown', onKey, { capture: true })
    const unlisten = listen('menu://settings', () => runAction('openSettings')).catch(() => () => {})
    return () => {
      window.removeEventListener('keydown', onKey, { capture: true })
      unlisten.then((f) => f())
    }
  }, [])

  return (
    <div className="app">
      <TabBar activeGit={git} />
      <div data-testid="panes" className="panes">
        {/* Все вкладки остаются смонтированными: неактивные скрыты, сессии живут. */}
        {loaded && tabs.map((t) => <PaneView key={t.id} tab={t} visible={t.id === active} />)}
        {loaded && tabs.length === 0 && (
          <div className="stalled" role="alert">
            <p>Оболочка завершается сразу после запуска. Проверьте ~/.zprofile / ~/.zshrc.</p>
            <button type="button" onClick={() => useTabs.getState().newTab()}>
              Открыть снова
            </button>
          </div>
        )}
      </div>
      <div data-testid="statusbar" className="statusbar">
        <StatusBar cwd={cwd} git={git} claude={claude} />
      </div>
      <Toasts />
      <SettingsPanel open={settingsOpen} onClose={() => useUi.getState().setSettingsOpen(false)} />
    </div>
  )
}
