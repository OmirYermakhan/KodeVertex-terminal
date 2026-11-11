import { useEffect } from 'react'
import { useSettings } from './settings/store'
import { listen } from '@tauri-apps/api/event'
import { useTabs } from './layout/tabsStore'
import { runAction } from './keys/actions'
import { matchKey } from './keys/keymap'
import PaneView from './ui/PaneView'
import TabBar from './ui/TabBar'

export default function App() {
  const loaded = useSettings((s) => s.loaded)
  const tabs = useTabs((s) => s.tabs)
  const active = useTabs((s) => s.active)

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
      <div data-testid="statusbar" className="statusbar" />
    </div>
  )
}
