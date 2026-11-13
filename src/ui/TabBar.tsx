import { useEffect, useState } from 'react'
import { useTabs, type Tab } from '../layout/tabsStore'
import { projectName, useHome, type GitInfo } from '../status/useGitInfo'
import { claudeOpen, useClaudeSessions } from '../claude/sessionStore'
import { tabStatus } from './tabStatus'

export function tabTitle(t: Tab, git: GitInfo | null = null, home = ''): string {
  const cwd = t.cwd[t.focused]
  return cwd ? projectName(cwd, git, home) : 'Терминал'
}

/**
 * Полоса вкладок (макет 04-main-window `.bar/.tabs/.tab`). Кнопки окна macOS — родные
 * (titleBarStyle: Overlay, trafficLightPosition на месте трёх точек макета), поэтому вкладки
 * начинаются там же, где в макете: 14 + 3·11 + 2·8 (точки) + 8 (gap) + 16 (margin) = 87px.
 * Перетаскивание окна работает только по самой полосе и пустому месту: у вкладок атрибута нет.
 * activeGit — git-данные активной вкладки (считаются один раз в App); у остальных вкладок — имя папки.
 *
 * Точка вкладки: работает — синяя пульсирующая, ждёт — жёлтая, ошибка — красная, готово — зелёная,
 * пока вкладку не открыли; у активной вкладки без этих состояний — точка --acc, как в макете.
 */
export default function TabBar({ activeGit = null }: { activeGit?: GitInfo | null }) {
  const tabs = useTabs((s) => s.tabs)
  const active = useTabs((s) => s.active)
  const sessions = useClaudeSessions((s) => s.sessions)
  const { activate, closeTab, newTab } = useTabs.getState()
  const home = useHome()
  // Когда вкладку смотрели в последний раз: «готово» после этого — ещё не увиденное.
  const [seen, setSeen] = useState<Record<string, number>>({})

  const activeTab = tabs.find((t) => t.id === active)
  const activeDoneAt = activeTab ? (tabStatus(activeTab, sessions)?.doneAt ?? 0) : 0
  useEffect(() => {
    if (!active) return
    setSeen((s) => ({ ...s, [active]: Date.now() }))
  }, [active, activeDoneAt])

  return (
    <div data-testid="tabbar" data-tauri-drag-region className="bar">
      {tabs.map((t) => {
        const on = t.id === active
        const st = tabStatus(t, sessions)
        let dot: string | null = on ? 'on' : null
        if (st && st.status !== 'done') dot = st.status
        else if (st?.status === 'done' && !on && st.doneAt > (seen[t.id] ?? 0)) dot = 'done'
        const claude = claudeOpen(sessions[t.focused])
        return (
          <div
            key={t.id}
            role="tab"
            aria-selected={on}
            className={on ? 'tab on' : 'tab'}
            onClick={() => activate(t.id)}
            onAuxClick={(e) => {
              if (e.button === 1) closeTab(t.id)
            }}
          >
            {dot && <i className={`tdot ${dot}`} data-testid="tab-dot" data-status={dot} />}
            <span>
              {tabTitle(t, on ? activeGit : null, home)}
              {claude ? ' · claude' : ''}
            </span>
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
      <button type="button" className="tab tab-add" aria-label="Новая вкладка" onClick={() => newTab()}>
        +
      </button>
      <div data-tauri-drag-region style={{ flex: 1, alignSelf: 'stretch' }} />
    </div>
  )
}
