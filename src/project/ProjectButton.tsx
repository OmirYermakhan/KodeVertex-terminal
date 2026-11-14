import { projectName, useHome, type GitInfo } from '../status/useGitInfo'
import { BranchIcon } from './icons'
import { useProject } from './store'

/** Две буквы значка: «shop-app» → SA, одно слово — первые две буквы. */
export function projectInitials(name: string): string {
  const words = name.split(/[-_.\s]+/).filter(Boolean)
  const s = words.length >= 2 ? words[0][0] + words[1][0] : (words[0] ?? name).slice(0, 2)
  return s.toUpperCase()
}

/**
 * Кнопка проекта слева вверху (макет 07 `.proj`): значок, имя, ветка, «▾».
 * Имя — как в строке состояния (projectName), ветка — из того же git, что считает App.
 * Клик — окно «Проект» (повторный — скрыть).
 */
export default function ProjectButton({ cwd, git }: { cwd: string | undefined; git: GitInfo | null }) {
  const on = useProject((s) => s.tool === 'project')
  const home = useHome()
  const name = cwd ? projectName(cwd, git, home) : 'Терминал'
  return (
    <button
      type="button"
      className={on ? 'proj on' : 'proj'}
      title="Проект ⌥⌘1"
      onClick={() => useProject.getState().toggle('project')}
    >
      <span className="pi">{projectInitials(name)}</span>
      {name}
      {git?.branch && (
        <span className="br">
          <BranchIcon size={12} strokeWidth={1.5} />
          {git.branch}
        </span>
      )}
      <span className="chev">▾</span>
    </button>
  )
}
