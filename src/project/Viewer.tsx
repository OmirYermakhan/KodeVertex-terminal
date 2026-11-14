import { useLayoutEffect, useRef } from 'react'
import DiffTab from './DiffTab'
import FileView from './FileView'
import { fileIcon } from './fileIcon'
import { statusOf, useProject, type ViewerTab } from './store'

const baseName = (rel: string) => rel.slice(rel.lastIndexOf('/') + 1)

/** Подпись вкладки: файл — имя; изменения — «имя · изменения» или «имя · хэш» (макет 07 `.et`). */
export function viewerTabTitle(t: ViewerTab): string {
  const name = baseName(t.rel)
  if (t.kind === 'file') return name
  return `${name} · ${t.rev ? t.rev.slice(0, 7) : 'изменения'}`
}

/**
 * Просмотр справа (макет 07 `.ed`): вкладки файлов и изменений. Файл — FileView; изменения — DiffTab.
 * data-viewer: ⌘W при фокусе здесь закрывает вкладку.
 * Вкладка изменений скрывает панели терминала — фокус переводим сюда (иначе он пропал бы со скрытой панелью).
 */
export default function Viewer() {
  const tabs = useProject((s) => s.tabs)
  const active = useProject((s) => s.active)
  const changes = useProject((s) => s.changes)
  const edRef = useRef<HTMLDivElement>(null)
  const cur = tabs[active]
  const diffKey = cur?.kind === 'diff' ? `${cur.rel}\0${cur.rev ?? ''}` : null
  useLayoutEffect(() => {
    const ed = edRef.current
    if (diffKey !== null && ed && !ed.contains(document.activeElement)) ed.focus()
  }, [diffKey])
  if (tabs.length === 0) return null
  return (
    <div
      ref={edRef}
      className={cur?.kind === 'diff' ? 'ed full' : 'ed'}
      data-testid="viewer"
      data-viewer=""
      tabIndex={-1}
    >
      <div className="etabs" role="tablist">
        {tabs.map((t, i) => {
          // Имя файла — цветом git-статуса, как в дереве (макет 07 `.et.mod`).
          const st = t.kind === 'file' ? statusOf(changes, t.rel) : null
          const cls = ['et', i === active && 'on', st].filter(Boolean).join(' ')
          return (
            <div
              key={`${t.kind}:${t.rel}:${t.kind === 'diff' ? t.rev : ''}`}
              role="tab"
              aria-selected={i === active}
              className={cls}
              onClick={() => useProject.setState({ active: i })}
            >
              {fileIcon(baseName(t.rel))}
              {viewerTabTitle(t)}
              <button
                type="button"
                className="x"
                aria-label="Закрыть вкладку"
                onClick={(e) => {
                  e.stopPropagation()
                  useProject.getState().closeTab(i)
                }}
              >
                ✕
              </button>
            </div>
          )
        })}
      </div>
      {cur?.kind === 'file' && <FileView key={cur.rel} rel={cur.rel} />}
      {cur?.kind === 'diff' && <DiffTab key={`${cur.rel}\0${cur.rev ?? ''}`} rel={cur.rel} rev={cur.rev} />}
    </div>
  )
}
