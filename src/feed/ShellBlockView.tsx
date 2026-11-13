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

/**
 * Панелька над блоком или ответом (макет 06, сцена Г): видна при наведении и у выбранного (CSS).
 * «⌘L в сообщение» можно и перетащить в строку ввода (TerminalPane).
 */
export const READ_ACTION = '⌘R читать'
/** Пузырь «Вы»: изменить отправленное сообщение. */
export const EDIT_ACTION = '✎ Изменить'

export function HoverActions({
  id,
  onAttach,
  onCopy,
  onRead,
  onEdit,
}: {
  id: string
  onAttach?(id: string): void
  onCopy?(id: string): void
  onRead?(id: string): void
  onEdit?(id: string): void
}) {
  if (!onAttach && !onCopy && !onRead && !onEdit) return null
  return (
    <div className="hover-act">
      {onEdit && (
        <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => onEdit(id)}>
          {EDIT_ACTION}
        </button>
      )}
      {onAttach && (
        <button type="button" className="on" onMouseDown={(e) => e.preventDefault()} onClick={() => onAttach(id)}>
          {ATTACH_ACTION}
        </button>
      )}
      {onCopy && (
        <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => onCopy(id)}>
          {COPY_ACTION}
        </button>
      )}
      {onRead && (
        <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => onRead(id)}>
          {READ_ACTION}
        </button>
      )}
    </div>
  )
}

/** Подпись строки с выводом оболочки в простое (сообщения о фоновых заданиях). */
export const NOTICE_LABEL = 'фоновая задача'

export const ShellBlockView = memo(function ShellBlockView({ block, selected, live, onAttach, onCopy }: ShellBlockViewProps) {
  if (block.notice !== undefined) {
    return (
      <div className="blk-notice" data-block-id={block.id}>
        <span className="lbl">{NOTICE_LABEL}</span>
        <span className="txt">{block.notice}</span>
      </div>
    )
  }
  const failed = block.exitCode !== null && block.exitCode !== 0
  const cls = ['blk', selected && 'sel', failed && 'err', block.running && 'run'].filter(Boolean).join(' ')
  return (
    <div className={cls} data-block-id={block.id}>
      {!block.running && <HoverActions id={block.id} onAttach={onAttach} onCopy={onCopy} />}
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
