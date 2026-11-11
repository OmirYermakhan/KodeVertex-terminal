import { useTabs, type Tab } from '../layout/tabsStore'

export function tabTitle(t: Tab): string {
  const cwd = t.cwd[t.focused]
  if (!cwd) return 'Терминал'
  const parts = cwd.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? '/'
}

// Левый отступ 80px освобождает место под кнопки окна macOS (titleBarStyle: Overlay).
// Перетаскивание окна работает только по самой полосе и пустому месту: у вкладок атрибута нет.
export default function TabBar() {
  const tabs = useTabs((s) => s.tabs)
  const active = useTabs((s) => s.active)
  const { activate, closeTab, newTab } = useTabs.getState()

  return (
    <div
      data-testid="tabbar"
      data-tauri-drag-region
      style={{
        height: 38,
        flexShrink: 0,
        boxSizing: 'border-box',
        paddingLeft: 80,
        paddingRight: 14,
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        background: 'var(--panel)',
        borderBottom: '1px solid var(--rule)',
        fontFamily: 'var(--font-code)',
        fontSize: 12,
      }}
    >
      {tabs.map((t) => {
        const on = t.id === active
        return (
          <div
            key={t.id}
            role="tab"
            aria-selected={on}
            className="tab"
            onClick={() => activate(t.id)}
            onAuxClick={(e) => {
              if (e.button === 1) closeTab(t.id)
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              padding: '5px 11px',
              borderRadius: 6,
              cursor: 'default',
              color: on ? 'var(--strong)' : 'var(--muted)',
              background: on ? 'var(--bg)' : 'transparent',
              userSelect: 'none',
            }}
          >
            <span>{tabTitle(t)}</span>
            <button
              type="button"
              className="tab-close"
              aria-label="Закрыть вкладку"
              onClick={(e) => {
                e.stopPropagation()
                closeTab(t.id)
              }}
            >
              ×
            </button>
          </div>
        )
      })}
      <button type="button" className="tab-add" aria-label="Новая вкладка" onClick={() => newTab()}>
        +
      </button>
      <div data-tauri-drag-region style={{ flex: 1, alignSelf: 'stretch' }} />
    </div>
  )
}
