import type { ReactNode } from 'react'
import { BranchIcon, ChangesIcon, FolderIcon } from './icons'
import { useProject, type Tool } from './store'

const ITEMS: { tool: Tool; label: string; keys: string; icon: ReactNode }[] = [
  { tool: 'project', label: 'Проект', keys: '⌥⌘1', icon: <FolderIcon /> },
  { tool: 'changes', label: 'Изменения', keys: '⌥⌘0', icon: <ChangesIcon /> },
  { tool: 'git', label: 'Git', keys: '⌥⌘9', icon: <BranchIcon /> },
]

/** Полоса инструментов слева (макет 07 `.stripe/.sb`), видна всегда; активный — синяя плашка. */
export default function Stripe() {
  const tool = useProject((s) => s.tool)
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
    </div>
  )
}
