import { useEffect } from 'react'
import TabBar from './components/TabBar'
import { useSettings } from './settings/store'
import TerminalPane from './terminal/TerminalPane'

export default function App() {
  const loaded = useSettings((s) => s.loaded)

  useEffect(() => {
    useSettings.getState().load()
  }, [])

  return (
    <div className="app">
      <TabBar />
      <div data-testid="panes" className="panes">
        {/* Временно: одна панель до появления вкладок и сплитов. */}
        {loaded && (
          <TerminalPane paneId="main" focused onCwd={() => {}} onExit={() => {}} onFocus={() => {}} />
        )}
      </div>
      <div data-testid="statusbar" className="statusbar" />
    </div>
  )
}
