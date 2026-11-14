import { useEffect, useLayoutEffect, useRef } from 'react'
import type { GitInfo } from '../status/useGitInfo'
import ChangesView from './ChangesView'
import GitLog from './GitLog'
import ProjectTree from './ProjectTree'
import { useProject, type Tool } from './store'

/** Заголовок окна (макет 07 `.twh`): название, серая подпись, кнопки справа; «—» — скрыть. */
const HEAD: Record<Tool, { title: string; sub: (branch: string | null) => string; acts: string[] }> = {
  project: { title: 'Проект', sub: () => '▾', acts: ['⌖', '⇕', '⋮'] },
  changes: { title: 'Изменения', sub: (b) => b ?? '', acts: ['↻', '⇕'] },
  git: { title: 'Git', sub: (b) => (b ? `лог · ${b}` : 'лог'), acts: ['⌕', '↻'] },
}

/**
 * Окно инструмента слева (макет 07 `.tw`): ширина из стора (тянуть за правый край, 200–600),
 * Открылось (клавишей, полосой, кнопкой) — фокус в окно, чтобы esc работал сразу; esc внутри — скрыть.
 * Закрылось — фокус возвращается туда, откуда пришёл (строка ввода), если он не ушёл сам в другое место.
 */
export default function ToolWindow({ git }: { git: GitInfo | null }) {
  const tool = useProject((s) => s.tool)
  const width = useProject((s) => s.width)
  const prevFocus = useRef<HTMLElement | null>(null)
  const stopDrag = useRef<(() => void) | null>(null)
  useEffect(() => () => stopDrag.current?.(), [])
  const twRef = useRef<HTMLDivElement>(null)
  const wasOpen = useRef(false)
  // Кнопки полосы и кнопка проекта — не «откуда пришли»: фокус с них возвращаем дальше.
  const passing = (a: Element | null) => !a || a === document.body || !!a.closest('.stripe, .proj')
  useLayoutEffect(() => {
    if (tool) {
      const tw = twRef.current
      const a = document.activeElement as HTMLElement | null
      if (tw && !tw.contains(a)) {
        if (!passing(a)) prevFocus.current = a
        tw.focus()
      }
      wasOpen.current = true
    } else if (wasOpen.current) {
      wasOpen.current = false
      const p = prevFocus.current
      if (passing(document.activeElement) && p?.isConnected) p.focus()
    }
  }, [tool])
  if (!tool) return null
  const head = HEAD[tool]
  const branch = git?.branch ?? null

  const hide = () => useProject.getState().close()

  const onResizeStart = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    const startX = e.clientX
    const startW = useProject.getState().width
    const move = (ev: MouseEvent) => useProject.getState().setWidth(startW + ev.clientX - startX)
    const up = () => stopDrag.current?.()
    stopDrag.current = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.classList.remove('tw-resizing')
      stopDrag.current = null
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    document.body.classList.add('tw-resizing')
  }

  return (
    <div
      ref={twRef}
      className="tw"
      data-testid="toolwindow"
      tabIndex={-1}
      style={{ width }}
      onFocusCapture={(e) => {
        const from = e.relatedTarget as HTMLElement | null
        if (from && !e.currentTarget.contains(from)) prevFocus.current = from
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || e.defaultPrevented) return
        e.preventDefault()
        hide()
      }}
    >
      <div className="twh">
        {head.title} <span className="sub">{head.sub(branch)}</span>
        <div className="acts">
          {head.acts.map((a) => (
            <span key={a}>{a}</span>
          ))}
          <button type="button" aria-label="Скрыть" title="Скрыть" onClick={hide}>
            —
          </button>
        </div>
      </div>
      {tool === 'project' && <ProjectTree />}
      {tool === 'changes' && <ChangesView />}
      {tool === 'git' && <GitLog />}
      <div className="tw-resize" data-testid="tw-resize" onMouseDown={onResizeStart} />
    </div>
  )
}
