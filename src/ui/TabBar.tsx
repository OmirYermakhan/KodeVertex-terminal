import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useTabs, type Tab } from '../layout/tabsStore'
import { projectName, useHome, type GitInfo } from '../status/useGitInfo'
import { claudeOpen, useClaudeSessions } from '../claude/sessionStore'
import { tabStatus, type ClaudeStatus } from './tabStatus'
import ProjectButton from '../project/ProjectButton'
import { useSettings } from '../settings/store'
import { LauncherIcon } from '../launch/LauncherIcon'

export function tabTitle(t: Tab, git: GitInfo | null = null, home = ''): string {
  const cwd = t.cwd[t.focused]
  return cwd ? projectName(cwd, git, home) : 'Терминал'
}

/**
 * Полоса вкладок (макет 04-main-window `.bar/.tabs/.tab`). Кнопки окна macOS — родные
 * (titleBarStyle: Overlay, trafficLightPosition на месте трёх точек макета). Сразу за ними —
 * кнопка проекта (макет 07 `.proj`): 20px от правого края «развернуть», как от третьей точки в макете;
 * вкладки — в 18px за ней (gap 8 + margin 10 макета).
 * Перетаскивание окна работает только по самой полосе и пустому месту: у вкладок и кнопки атрибута нет.
 * activeGit — git-данные активной вкладки (считаются один раз в App); у остальных вкладок — имя папки.
 *
 * Точка вкладки: работает — синяя пульсирующая, ждёт — жёлтая, ошибка — красная, готово — зелёная,
 * пока вкладку не открыли; у активной вкладки без этих состояний — точка --acc, как в макете.
 */
export default function TabBar({ activeGit = null }: { activeGit?: GitInfo | null }) {
  const tabs = useTabs((s) => s.tabs)
  const active = useTabs((s) => s.active)
  // Из сессий — только то, что рисует полоса (по вкладке: точка, время «готово», «· claude»), плоским
  // массивом со сравнением по элементам: токены ответа в любой панели полосу не перерисовывают.
  const flat = useClaudeSessions(
    useShallow((s) =>
      tabs.flatMap((t) => {
        const st = tabStatus(t, s.sessions)
        return [st?.status ?? null, st?.doneAt ?? 0, claudeOpen(s.sessions[t.focused])]
      }),
    ),
  )
  const info = (i: number) => {
    const status = flat[i * 3] as ClaudeStatus | null
    return { st: status ? { status, doneAt: flat[i * 3 + 1] as number } : null, claude: flat[i * 3 + 2] as boolean }
  }
  const { activate, closeTab, newTab } = useTabs.getState()
  const home = useHome()
  const launchers = useSettings((s) => s.settings.launchers)
  // Когда вкладку смотрели в последний раз: «готово» после этого — ещё не увиденное.
  const [seen, setSeen] = useState<Record<string, number>>({})

  const activeIdx = tabs.findIndex((t) => t.id === active)
  const activeTab = activeIdx >= 0 ? tabs[activeIdx] : undefined
  const activeDoneAt = activeTab ? (info(activeIdx).st?.doneAt ?? 0) : 0
  useEffect(() => {
    if (!active) return
    setSeen((s) => ({ ...s, [active]: Date.now() }))
  }, [active, activeDoneAt])

  return (
    <div data-testid="tabbar" data-tauri-drag-region className="bar">
      <ProjectButton cwd={activeTab?.cwd[activeTab.focused]} git={activeGit} />
      {tabs.map((t, i) => {
        const on = t.id === active
        const { st, claude } = info(i)
        let dot: string | null = on ? 'on' : null
        if (st && st.status !== 'done') dot = st.status
        else if (st?.status === 'done' && !on && st.doneAt > (seen[t.id] ?? 0)) dot = 'done'
        const l = t.launcher ? launchers.find((x) => x.id === t.launcher) : undefined
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
            {l && (
              <span className="tab-li" style={{ color: l.color }}>
                <LauncherIcon icon={l.icon} size={13} />
              </span>
            )}
            <span>
              {l ? l.name : tabTitle(t, on ? activeGit : null, home)}
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
