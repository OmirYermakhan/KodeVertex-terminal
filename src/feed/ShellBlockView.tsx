import { memo, useState, type ReactNode } from 'react'
import { serializedRows } from './blockHtml'
import { COLLAPSE_LINES, COLLAPSED_ROWS, formatDuration, type ShellBlock } from './feed'

export interface ShellBlockViewProps {
  block: ShellBlock
  selected: boolean
  /** Живой терминал running-блока. */
  live?: ReactNode
  /** «⌘L в сообщение» в панельке над блоком (макет 06, сцена Г). */
  onAttach?(id: string): void
  /** «⌘⇧C копировать». */
  onCopy?(id: string): void
}

export const ATTACH_ACTION = '⌘L в сообщение'
export const COPY_ACTION = '⌘⇧C копировать'

function Output({ block }: { block: ShellBlock }) {
  const [all, setAll] = useState(false)
  const html = block.html ?? ''
  if (!html) return null
  // Длинный блок рисуем свёрнутым: первые COLLAPSED_ROWS строк и кнопка.
  const collapsed = !all && block.lines > COLLAPSE_LINES
  const shown = collapsed ? serializedRows(html).slice(0, COLLAPSED_ROWS).join('') : html
  return (
    <>
      {/* HTML только из SerializeAddon (текст экранирован аддоном), см. blockHtml.ts. */}
      <div className="out" dangerouslySetInnerHTML={{ __html: shown }} />
      {collapsed && (
        <button type="button" className="blk-more" onClick={() => setAll(true)}>
          Показать всё ({block.lines} строк)
        </button>
      )}
    </>
  )
}

export const ShellBlockView = memo(function ShellBlockView({ block, selected, live, onAttach, onCopy }: ShellBlockViewProps) {
  const failed = block.exitCode !== null && block.exitCode !== 0
  const cls = ['blk', selected && 'sel', failed && 'err', block.running && 'run'].filter(Boolean).join(' ')
  return (
    <div className={cls} data-block-id={block.id}>
      {!block.running && (onAttach || onCopy) && (
        // Панелька над блоком: видна при наведении и у выбранного блока (CSS).
        <div className="hover-act">
          {onAttach && (
            <button type="button" className="on" onMouseDown={(e) => e.preventDefault()} onClick={() => onAttach(block.id)}>
              {ATTACH_ACTION}
            </button>
          )}
          {onCopy && (
            <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => onCopy(block.id)}>
              {COPY_ACTION}
            </button>
          )}
        </div>
      )}
      <div className="bh">
        <span>
          <span className="p">❯</span> <span className="cmd">{block.command}</span>
        </span>
        <span>
          {failed && <span className="exit">exit {block.exitCode}</span>}
          {failed && block.durationMs !== null && ' · '}
          {block.durationMs !== null && formatDuration(block.durationMs)}
        </span>
      </div>
      {block.running ? live : <Output block={block} />}
    </div>
  )
})
