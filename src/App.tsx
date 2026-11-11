import TabBar from './components/TabBar'

export default function App() {
  return (
    <div className="app">
      <TabBar />
      <div data-testid="panes" className="panes" />
      <div data-testid="statusbar" className="statusbar" />
    </div>
  )
}
