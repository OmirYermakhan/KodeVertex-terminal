import { memo, useMemo, useState, type ReactNode } from 'react'
import { blockText, isSerializedHtml, serializedRows } from './blockHtml'
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
  /** «Повторить» в заголовке (занята ли оболочка — проверяет сам обработчик: колбэк стабилен, memo блоков не сбивается). */
  onRepeat?(id: string): void
  /** «Спросить Claude» в заголовке упавшего блока (код ≠ 0). */
  onAsk?(id: string): void
}

export const ATTACH_ACTION = '⌘L в сообщение'
export const COPY_ACTION = '⌘⇧C копировать'
export const REPEAT_ACTION = 'Повторить'
export const ASK_ACTION = 'Спросить Claude'

function Output({ block }: { block: ShellBlock }) {
  const [all, setAll] = useState(false)
  const html = block.html ?? ''
  // Длинный блок рисуем свёрнутым: первые COLLAPSED_ROWS строк и кнопка.
  const collapsed = !all && block.lines > COLLAPSE_LINES
  // HTML восстановленной ленты читается с диска (session.json): форма аддона проверяется один раз на HTML.
  const safe = useMemo(() => isSerializedHtml(html), [html])
  const shown = useMemo(
    () => (!safe ? '' : collapsed ? serializedRows(html).slice(0, COLLAPSED_ROWS).join('') : html),
    [html, collapsed, safe],
  )
  const text = useMemo(() => (safe ? '' : blockText(html)), [html, safe])
  if (!html) return null
  return (
    <>
      {safe ? (
        // HTML только из SerializeAddon (текст экранирован аддоном), форма проверена isSerializedHtml.
        <div className="out" dangerouslySetInnerHTML={{ __html: shown }} />
      ) : (
        // Не та форма (подправленный файл сессии) — только текст.
        <div className="out">{text}</div>
      )}
      {safe && collapsed && (
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

/** Заголовок блока без команды: вывод оболочки между командами (direnv, «[1] + done»). */
export const SHELL_OUTPUT = 'вывод оболочки'

/** Блок шёл, когда приложение закрылось (восстановлен из сохранённой сессии). */
export const INTERRUPTED = 'прервано'

export const ShellBlockView = memo(function ShellBlockView({ block, selected, live, onAttach, onCopy, onRepeat, onAsk }: ShellBlockViewProps) {
  const failed = block.exitCode !== null && block.exitCode !== 0
  const cls = ['blk', selected && 'sel', failed && 'err', block.running && 'run'].filter(Boolean).join(' ')
  // Вывод оболочки вне команды (до набранной строки) — без команды: повторять нечего.
  const repeat = !block.running && block.command !== '' && onRepeat
  const ask = !block.running && failed && onAsk
  return (
    <div className={cls} data-block-id={block.id}>
      {!block.running && <HoverActions id={block.id} onAttach={onAttach} onCopy={onCopy} />}
      <div className="bh">
        <span>
          {block.command !== '' ? (
            <>
              <span className="p">❯</span> <span className="cmd">{block.command}</span>
            </>
          ) : (
            <span className="cmd none">{SHELL_OUTPUT}</span>
          )}
        </span>
        <span>
          {(repeat || ask) && (
            // Видны при наведении и у выбранного блока (CSS), перед длительностью.
            <span className="bh-act">
              {repeat && (
                <button type="button" className="rep" title="⌘R" onMouseDown={(e) => e.preventDefault()} onClick={() => repeat(block.id)}>
                  {REPEAT_ACTION}
                </button>
              )}
              {ask && (
                <button type="button" className="ask" title="⌘⇧A" onMouseDown={(e) => e.preventDefault()} onClick={() => ask(block.id)}>
                  {ASK_ACTION}
                </button>
              )}
            </span>
          )}
          {block.interrupted && <span className="exit">{INTERRUPTED}</span>}
          {failed && <span className="exit">exit {block.exitCode}</span>}
          {(failed || block.interrupted) && block.durationMs !== null && ' · '}
          {block.durationMs !== null && formatDuration(block.durationMs)}
        </span>
      </div>
      {block.running ? live : <Output block={block} />}
    </div>
  )
})
