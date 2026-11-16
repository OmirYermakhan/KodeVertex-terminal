import { useEffect, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useSettings } from './settings/store'
import { listen } from '@tauri-apps/api/event'
import { useTabs } from './layout/tabsStore'
import { runAction } from './keys/actions'
import { matchKey, type Action } from './keys/keymap'
import PaneView from './ui/PaneView'
import TabBar from './ui/TabBar'
import StatusBar, { type ClaudeStatus } from './ui/StatusBar'
import SettingsPanel from './ui/SettingsPanel'
import CommandPalette from './palette/CommandPalette'
import { useUi } from './ui/uiStore'
import { useGitInfo } from './status/useGitInfo'
import Toasts from './notify/Toasts'
import { installNotifications } from './notify/notify'
import { claudeOpen, useClaudeSessions } from './claude/sessionStore'
import { installDragDrop, useAttachCount } from './attach/dragDrop'
import Stripe from './project/Stripe'
import LauncherDialog from './launch/LauncherDialog'
import ToolWindow from './project/ToolWindow'
import Viewer from './project/Viewer'
import { useProject } from './project/store'
import { localSummary } from './project/changeRow'
import { installAutoRefresh } from './project/autoRefresh'

/** Подсказка клавиш окна инструмента в строке состояния (макет 07, окна 2–3). */
const TOOL_HINT = {
  changes: '↑↓ выбрать · ↵ открыть изменения · ⌘↓ открыть файл',
  git: '↑↓ коммиты · → файлы · ↵ изменения',
} as const

const REPEATABLE = new Set<Action>(['fontBigger', 'fontSmaller'])

/** ⌘↑/⌘↓ по блокам ленты — не в окне инструмента: там ⌘↓ открывает файл («Изменения»). */
const BLOCK_NAV = new Set<Action>(['blockPrev', 'blockNext'])

/**
 * Поля сессии Claude для строки состояния панели в фокусе — по отдельности (useShallow): поток
 * ответа меняет ClaudeState на каждом шаге, а окно перерисовывается, только когда сменилось видимое.
 */
function useClaudeStatus(paneId: string | undefined): { claude: ClaudeStatus | undefined; permissionMode: string | null | undefined } {
  const f = useClaudeSessions(
    useShallow((s) => {
      const p = paneId ? s.sessions[paneId] : undefined
      if (!claudeOpen(p)) return null
      const st = p.state
      const cur = st.currentAgentId ? st.agents.find((a) => a.id === st.currentAgentId) : undefined
      return {
        model: st.model,
        contextUsed: st.contextUsed,
        contextMax: st.contextMax,
        costUsd: st.costUsd,
        currentAgentId: st.currentAgentId,
        currentName: cur?.name ?? null,
        permissionMode: p.permissionMode,
      }
    }),
  )
  const claude = useMemo((): ClaudeStatus | undefined => {
    if (!f) return undefined
    const { model, contextUsed, contextMax, costUsd, currentAgentId, currentName } = f
    const agents = currentAgentId && currentName !== null ? [{ id: currentAgentId, name: currentName }] : []
    return { model, contextUsed, contextMax, costUsd, currentAgentId, agents }
  }, [f])
  return { claude, permissionMode: f?.permissionMode }
}

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
  const { claude, permissionMode } = useClaudeStatus(focusedPane)
  const settingsOpen = useUi((s) => s.settingsOpen)
  const paletteOpen = useUi((s) => s.paletteOpen)
  const launcherEdit = useUi((s) => s.launcherEdit)
  // Вкладка изменений занимает всю область справа: панели терминала скрыты как неактивная вкладка
  // (смонтированы; при возврате — фокус в строку ввода и доведённые анимации, см. PaneView).
  const diffOpen = useProject((s) => s.tabs[s.active]?.kind === 'diff')
  const viewerFile = useProject((s) => {
    const t = s.tabs[s.active]
    return t?.kind === 'file' ? t.rel : null
  })
  const viewerLine = useProject((s) => (viewerFile ? (s.cursors[viewerFile] ?? 1) : 1))
  // Сводка git при открытой панели: «N изменено · M новый»; в «Git» — выбранный коммит.
  const tool = useProject((s) => s.tool)
  const projectSeg = useProject((s) =>
    s.tool === null ? null : ((s.tool === 'git' ? s.commitStat : null) ?? localSummary(s.changes, s.moreUntracked)),
  )
  const attachments = useAttachCount((s) => (focusedPane ? (s.counts[focusedPane] ?? 0) : 0))

  useEffect(() => {
    useSettings.getState().load()
  }, [])

  useEffect(() => installNotifications(), [])
  // Панель проекта показывает проект панели в фокусе: смена вкладки, панели или cd меняют корень.
  useEffect(() => {
    if (cwd) useProject.getState().setRoot(cwd)
  }, [cwd])
  useEffect(() => installAutoRefresh(), [])
  // Файлы из Finder: оверлей и вставка — в панели под курсором (иначе в панели в фокусе).
  useEffect(
    () =>
      installDragDrop(() => {
        const s = useTabs.getState()
        return s.tabs.find((x) => x.id === s.active)?.focused ?? null
      }),
    [],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const a = matchKey(e)
      if (!a) return
      // Окно быстрого входа: клавиши (⌘A, ⌘←…) — его полям.
      if (useUi.getState().launcherEdit) return
      if (BLOCK_NAV.has(a) && e.target instanceof Element && e.target.closest('.tw')) return
      e.preventDefault()
      e.stopPropagation()
      // Автоповтор только для размера шрифта: зажатый ⌘W не должен закрыть всё подряд.
      if (e.repeat && !REPEATABLE.has(a)) return
      // Пока открыты настройки, остальные действия не должны менять вкладки за окном.
      if (useUi.getState().settingsOpen && a !== 'openSettings') return
      // Палитра ⌘P: клавиши — её строке; ⌘P закрывает её.
      if (useUi.getState().paletteOpen && a !== 'palette') return
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
      <div className="win-body">
        <Stripe />
        <ToolWindow git={git} />
        <div className="win-main">
          <div data-testid="panes" className={diffOpen ? 'panes off' : 'panes'}>
            {/* Все вкладки остаются смонтированными: неактивные скрыты, сессии живут. */}
            {loaded && tabs.map((t) => <PaneView key={t.id} tab={t} visible={t.id === active && !diffOpen} />)}
            {loaded && tabs.length === 0 && !diffOpen && (
              <div className="stalled" role="alert">
                <p>Оболочка завершается сразу после запуска. Проверьте ~/.zprofile / ~/.zshrc.</p>
                <button type="button" onClick={() => useTabs.getState().newTab()}>
                  Открыть снова
                </button>
              </div>
            )}
          </div>
          <Viewer />
        </div>
      </div>
      <div data-testid="statusbar" className="statusbar">
        <StatusBar
          cwd={cwd}
          git={git}
          claude={claude}
          attachments={attachments}
          permissionMode={permissionMode}
          project={projectSeg}
          hint={tool === 'changes' || tool === 'git' ? TOOL_HINT[tool] : null}
          file={
            viewerFile
              ? {
                  name: viewerFile.slice(viewerFile.lastIndexOf('/') + 1),
                  line: viewerLine,
                }
              : null
          }
        />
      </div>
      <Toasts />
      {paletteOpen && <CommandPalette onClose={() => useUi.getState().setPaletteOpen(false)} />}
      {launcherEdit && <LauncherDialog key={launcherEdit.id ?? 'new'} editId={launcherEdit.id} onClose={() => useUi.getState().setLauncherEdit(null)} />}
      <SettingsPanel open={settingsOpen} onClose={() => useUi.getState().setSettingsOpen(false)} />
    </div>
  )
}
