import { useEffect } from 'react'
import { useSettings } from './settings/store'
import { listen } from '@tauri-apps/api/event'
import { useTabs } from './layout/tabsStore'
import { runAction } from './keys/actions'
import { matchKey } from './keys/keymap'
import PaneView from './ui/PaneView'
import TabBar from './ui/TabBar'
import StatusBar from './ui/StatusBar'
import { useGitInfo } from './status/useGitInfo'

export default function App() {
  const loaded = useSettings((s) => s.loaded)
  const tabs = useTabs((s) => s.tabs)
  const active = useTabs((s) => s.active)
  const cwd = useTabs((s) => {
    const t = s.tabs.find((x) => x.id === s.active)
    return t?.cwd[t.focused]
  })
  const git = useGitInfo(cwd)

  useEffect(() => {
    useSettings.getState().load()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const a = matchKey(e)
      if (!a) return
      e.preventDefault()
      e.stopPropagation()
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
      <TabBar />
      <div data-testid="panes" className="panes">
        {/* Все вкладки остаются смонтированными: неактивные скрыты, сессии живут. */}
        {loaded && tabs.map((t) => <PaneView key={t.id} tab={t} visible={t.id === active} />)}
      </div>
      <div data-testid="statusbar" className="statusbar">
        <StatusBar cwd={cwd} git={git} />
      </div>
    </div>
  )
}
