import { useEffect } from 'react'
import { useSettings } from './settings/store'
import { useTabs } from './layout/tabsStore'
import PaneView from './ui/PaneView'
import TabBar from './ui/TabBar'

export default function App() {
  const loaded = useSettings((s) => s.loaded)
  const tabs = useTabs((s) => s.tabs)
  const active = useTabs((s) => s.active)

  useEffect(() => {
    useSettings.getState().load()
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
