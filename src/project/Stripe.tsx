import { useEffect, useState, type ReactNode } from 'react'
import { BranchIcon, ChangesIcon, FolderIcon } from './icons'
import { useProject, type Tool } from './store'
import { useSettings } from '../settings/store'
import { useTabs } from '../layout/tabsStore'
import { useUi } from '../ui/uiStore'
import { LauncherIcon } from '../launch/LauncherIcon'
import { launcherPane, openLauncher, usePaneRunning } from '../launch/runner'
import type { Launcher } from '../launch/launchers'

const ITEMS: { tool: Tool; label: string; keys: string; icon: ReactNode }[] = [
  { tool: 'project', label: 'Проект', keys: '⌥⌘1', icon: <FolderIcon /> },
  { tool: 'changes', label: 'Изменения', keys: '⌥⌘0', icon: <ChangesIcon /> },
  { tool: 'git', label: 'Git', keys: '⌥⌘9', icon: <BranchIcon /> },
]

export const ADD_LAUNCHER_TITLE = 'Новый вход (ssh, сервер, команда)'

/**
 * Полоса инструментов слева (макет 07 `.stripe/.sb`), видна всегда; активный — синяя плашка.
 * Ниже — быстрые входы (значок своего цвета; точка — сессия идёт), внизу «+» — новый вход.
 */
export default function Stripe() {
  const tool = useProject((s) => s.tool)
  const launchers = useSettings((s) => s.settings.launchers)
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  return (
    <div className="stripe" role="toolbar" aria-label="Инструменты">
      {ITEMS.map((it) => (
        <button
          key={it.tool}
          type="button"
          className={tool === it.tool ? 'sb on' : 'sb'}
          aria-label={it.label}
          aria-pressed={tool === it.tool}
          title={`${it.label} ${it.keys}`}
          onClick={() => useProject.getState().toggle(it.tool)}
        >
          {it.icon}
        </button>
      ))}
      {launchers.length > 0 && <i className="sb-sep" />}
      <div className="sb-launchers">
        {launchers.map((l) => (
          <LauncherButton key={l.id} l={l} onMenu={(x, y) => setMenu({ id: l.id, x, y })} />
        ))}
      </div>
      <button
        type="button"
        className="sb sb-add"
        aria-label={ADD_LAUNCHER_TITLE}
        title={ADD_LAUNCHER_TITLE}
        onClick={() => useUi.getState().setLauncherEdit({ id: null })}
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
          <path d="M8 3v10M3 8h10" />
        </svg>
      </button>
      {menu && <LauncherMenu {...menu} onClose={() => setMenu(null)} />}
    </div>
  )
}

function LauncherButton({ l, onMenu }: { l: Launcher; onMenu(x: number, y: number): void }) {
  const tab = useTabs((s) => s.tabs.find((t) => t.launcher === l.id))
  const on = useTabs((s) => !!tab && s.active === tab.id)
  const live = usePaneRunning((s) => (tab ? !!s.running[launcherPane(tab)] : false))
  return (
    <button
      type="button"
      className={on ? 'sb sb-l on' : 'sb sb-l'}
      style={{ '--lc': l.color } as React.CSSProperties}
      aria-label={l.name}
      aria-pressed={on}
      title={`${l.name}\n${l.command}${live ? '\n● сессия идёт' : ''}`}
      onClick={() => openLauncher(l)}
      onContextMenu={(e) => {
        e.preventDefault()
        onMenu(e.clientX, e.clientY)
      }}
    >
      <LauncherIcon icon={l.icon} />
      {live && <i className="sb-live" data-testid="launcher-live" />}
    </button>
  )
}

function LauncherMenu({ id, x, y, onClose }: { id: string; x: number; y: number; onClose(): void }) {
  useEffect(() => {
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return
      onClose()
    }
    const t = setTimeout(() => {
      window.addEventListener('mousedown', close)
      window.addEventListener('keydown', close, true)
      window.addEventListener('blur', close)
    }, 0)
    return () => {
      clearTimeout(t)
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', close, true)
      window.removeEventListener('blur', close)
    }
  }, [onClose])
  const act = (f: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation()
    onClose()
    f()
  }
  const remove = () => {
    const all = useSettings.getState().settings.launchers
    useSettings.getState().update({ launchers: all.filter((l) => l.id !== id) })
  }
  const l = useSettings.getState().settings.launchers.find((x) => x.id === id)
  return (
    <div className="sb-menu" role="menu" style={{ left: x, top: y }} onMouseDown={(e) => e.stopPropagation()}>
      <button type="button" role="menuitem" onClick={act(() => l && openLauncher(l))}>
        Открыть
      </button>
      <button type="button" role="menuitem" onClick={act(() => useUi.getState().setLauncherEdit({ id }))}>
        Изменить…
      </button>
      <button type="button" role="menuitem" className="danger" onClick={act(remove)}>
        Удалить
      </button>
    </div>
  )
}
