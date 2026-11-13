// Очередь сообщений Claude над строкой ввода (в .dock, под запросами агента): набранное, пока ход
// шёл, ждёт конца хода. Строки — приглушённые пузыри «Вы» (макет 04 .you), заголовок — как .dh.
import { forwardRef, useImperativeHandle, useRef, useState, type KeyboardEvent } from 'react'
import type { QueuedMessage } from './sessionStore'
import { segments } from '../attach/doc'
import { CLIP_PATH, Token } from '../attach/tokenView'
import { usePresence } from '../ui/motion'

export const QUEUE_KEYS = '↑ в пустой строке — изменить последнее · ⌫ убрать · esc к вводу'
export const PAUSE_HINT = 'пауза — ↵ отправить следующее'

export interface QueuePanelProps {
  queue: QueuedMessage[]
  /** Подсказка паузы (ход прерван или claude завершился). */
  paused: boolean
  onRemove(id: number): void
  /** esc: фокус обратно в строку ввода. */
  onExit(): void
}

export interface QueuePanelHandle {
  /** Фокус в очередь (на выбранную строку или первую). */
  focus(): void
  hasFocus(): boolean
}

export const QueuePanel = forwardRef<QueuePanelHandle, QueuePanelProps>(function QueuePanel(p, ref) {
  const boxRef = useRef<HTMLDivElement>(null)
  const [sel, setSel] = useState<number | null>(null)
  const selected = p.queue.some((m) => m.id === sel) ? sel : null

  const focusRow = (id: number | null) => {
    setSel(id)
    if (id === null) return
    boxRef.current?.querySelector<HTMLElement>(`[data-queue-id="${id}"]`)?.scrollIntoView?.({ block: 'nearest' })
  }

  useImperativeHandle(ref, () => ({
    focus: () => {
      if (selected === null) focusRow(p.queue[0]?.id ?? null)
      boxRef.current?.focus()
    },
    hasFocus: () => !!boxRef.current && boxRef.current.contains(document.activeElement),
  }))

  const remove = (id: number) => {
    const i = p.queue.findIndex((m) => m.id === id)
    const rest = p.queue.filter((m) => m.id !== id)
    p.onRemove(id)
    // Очередь опустела — назад к вводу; иначе выбор на соседнюю строку.
    if (rest.length === 0) p.onExit()
    else focusRow(rest[Math.min(i, rest.length - 1)].id)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const i = p.queue.findIndex((m) => m.id === selected)
    let handled = true
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (p.queue.length > 0) {
        const j = i < 0 ? 0 : Math.min(p.queue.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))
        focusRow(p.queue[j].id)
      }
    } else if (e.key === 'Backspace' || e.key === 'Delete') {
      if (selected !== null) remove(selected)
    } else if (e.key === 'Escape') {
      p.onExit()
    } else handled = false
    if (handled) {
      e.preventDefault()
      e.stopPropagation()
    }
  }

  const n = p.queue.length
  // Убранная строка ещё миг уходит (анимация в global.css), потом пропадает.
  const rows = usePresence(p.queue, (m) => m.id)
  return (
    <div className="queue" ref={boxRef} tabIndex={-1} role="listbox" aria-label="Очередь сообщений" onKeyDown={onKeyDown}>
      <div className="dh">
        <span>
          В очереди · <b>{n}</b>
          {p.paused && <span className="qu-pause"> · {PAUSE_HINT}</span>}
        </span>
        <span className="keys">{QUEUE_KEYS}</span>
      </div>
      <div className="qu-list">
        {rows.map(({ item: m, leaving }) => (
          <div
            key={m.id}
            className={'qu-row' + (leaving ? ' leaving' : m.id === selected ? ' focus' : '')}
            role={leaving ? undefined : 'option'}
            aria-hidden={leaving || undefined}
            aria-selected={leaving ? undefined : m.id === selected}
            data-queue-id={leaving ? undefined : m.id}
            onMouseDown={(e) => {
              e.preventDefault()
              focusRow(m.id)
              boxRef.current?.focus()
            }}
          >
            <span className="qu-text">
              {m.tokens && m.tokens.length > 0
                ? segments({ text: m.text, tokens: m.tokens }).map((s, i) => (s.type === 'text' ? s.text : <Token key={s.token.id + i} token={s.token} />))
                : m.text}
            </span>
            {m.tokens && m.tokens.length > 0 && (
              <span className="qu-clip" title={`Вложений: ${m.tokens.length}`}>
                <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
                  <path d={CLIP_PATH} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
                {m.tokens.length}
              </span>
            )}
            <span className="qu-tag">ждёт</span>
            <button
              type="button"
              className="qu-x"
              aria-label="Убрать из очереди"
              tabIndex={-1}
              onMouseDown={(e) => {
                e.preventDefault()
                e.stopPropagation()
                remove(m.id)
              }}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </div>
  )
})

export default QueuePanel
