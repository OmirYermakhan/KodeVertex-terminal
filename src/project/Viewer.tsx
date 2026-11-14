import { useProject, type ViewerTab } from './store'

const baseName = (rel: string) => rel.slice(rel.lastIndexOf('/') + 1)

/** Подпись вкладки: файл — имя; изменения — «имя · изменения» или «имя · хэш» (макет 07 `.et`). */
export function viewerTabTitle(t: ViewerTab): string {
  const name = baseName(t.rel)
  if (t.kind === 'file') return name
  return `${name} · ${t.rev ? t.rev.slice(0, 7) : 'изменения'}`
}

/**
 * Просмотр справа (макет 07 `.ed`): вкладки файлов и изменений. Пока — только оболочка вкладок;
 * содержимое файла и изменений — Task 6/7. data-viewer: ⌘W при фокусе здесь закрывает вкладку.
 */
export default function Viewer() {
  const tabs = useProject((s) => s.tabs)
  const active = useProject((s) => s.active)
  if (tabs.length === 0) return null
  const cur = tabs[active]
  return (
    <div className={cur?.kind === 'diff' ? 'ed full' : 'ed'} data-testid="viewer" data-viewer="" tabIndex={-1}>
      <div className="etabs" role="tablist">
        {tabs.map((t, i) => (
          <div
            key={`${t.kind}:${t.rel}:${t.kind === 'diff' ? t.rev : ''}`}
            role="tab"
            aria-selected={i === active}
            className={i === active ? 'et on' : 'et'}
            onClick={() => useProject.setState({ active: i })}
          >
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
        ))}
      </div>
      <div className="ed-body" />
    </div>
  )
}
