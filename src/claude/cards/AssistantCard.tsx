import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { modelLabel } from '../labels'
import { Markdown } from '../Markdown'
import type { Agent } from '../reducer'
import { HoverActions } from '../../feed/ShellBlockView'
import { isLongAnswer } from '../reader/ReaderView'
import { REVEAL_EVENT } from '../../feed/findInFeed'

/** «Имя агента · Модель»; без агента — «Claude». */
export function agentSignature(agent: Agent | undefined): string {
  if (!agent) return 'Claude'
  return agent.model ? `${agent.name} · ${modelLabel(agent.model)}` : agent.name
}

/** Длинный ответ сворачивается: больше ANSWER_COLLAPSE_LINES строк на экране или ANSWER_COLLAPSE_CHARS знаков. */
export const ANSWER_COLLAPSE_LINES = 40
export const ANSWER_COLLAPSE_CHARS = 4000
/** Свёрнутый ответ — первые 20 строк (высота — в global.css, `20lh`) с затуханием книзу. */
export const ANSWER_COLLAPSED_LINES = 20
export const SHOW_ALL = 'Показать всё'
export const COLLAPSE = 'Свернуть'

export function answerCollapsible(chars: number, lines: number): boolean {
  return chars > ANSWER_COLLAPSE_CHARS || lines > ANSWER_COLLAPSE_LINES
}

/** Строк текста в отрисованном ответе (полная высота / межстрочный интервал); 0 — не измерить. */
export function renderedLines(el: HTMLElement): number {
  const lh = parseFloat(getComputedStyle(el).lineHeight)
  return lh > 0 && el.scrollHeight > 0 ? Math.round(el.scrollHeight / lh) : 0
}

export const isFable = (agent: Agent | undefined): boolean => !!agent?.model?.toLowerCase().includes('fable')

/** Ответ агента: карточка с полосой слева (макет 04, .card); у Fable — золото. */
export const AssistantCard = memo(function AssistantCard({
  agent,
  text,
  streaming,
  id,
  selected,
  onAttach,
  onCopy,
  onRead,
}: {
  agent: Agent | undefined
  text: string
  streaming: boolean
  id?: string
  /** Выбран ⌘↑ (⌘L вложит его в сообщение). */
  selected?: boolean
  onAttach?(id: string): void
  onCopy?(id: string): void
  /** Открыть ответ в режиме чтения. */
  onRead?(id: string): void
}) {
  const long = !!onRead && !!id && isLongAnswer(text)
  const bodyRef = useRef<HTMLDivElement>(null)
  // «Развёрнуто» — состояние карточки: ре-рендер и новые сообщения его не сбрасывают.
  const [expanded, setExpanded] = useState(false)
  const [lines, setLines] = useState(0)
  // Пока идёт стрим, не меряем и не сворачиваем; после — по высоте отрисованного текста.
  useLayoutEffect(() => {
    const md = bodyRef.current?.querySelector<HTMLElement>('.md')
    setLines(!streaming && md ? renderedLines(md) : 0)
  }, [text, streaming])
  const collapsible = !streaming && answerCollapsible(text.length, lines)
  const collapsed = collapsible && !expanded
  // ⌘F нашёл текст в скрытой части — разворачиваем сразу (до прокрутки к совпадению).
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const reveal = () => {
      // Класс снимаем сразу: поиск меряет положение совпадения в этом же вызове, до рендера React.
      el.classList.remove('clipped')
      setExpanded(true)
    }
    el.addEventListener(REVEAL_EVENT, reveal)
    return () => el.removeEventListener(REVEAL_EVENT, reveal)
  }, [])
  const collapse = () => {
    setExpanded(false)
    // Свернули, стоя внизу длинного ответа, — карточка не должна уехать из виду.
    requestAnimationFrame(() => bodyRef.current?.parentElement?.scrollIntoView?.({ block: 'nearest' }))
  }
  return (
    <div className={(isFable(agent) ? 'card fable' : 'card') + (selected ? ' sel' : '')} data-item-id={id}>
      {!streaming && id && <HoverActions id={id} onAttach={onAttach} onCopy={onCopy} onRead={onRead} />}
      <div className="who">
        <span>{agentSignature(agent)}</span>
        {long && (
          <button type="button" className="read-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => onRead!(id!)}>
            Читать
          </button>
        )}
      </div>
      <div ref={bodyRef} className={collapsed ? 'ans-body clipped' : 'ans-body'}>
        <Markdown text={text} streaming={streaming} />
      </div>
      {collapsible && (
        <button type="button" className="blk-more ans-more" aria-expanded={!collapsed} onMouseDown={(e) => e.preventDefault()} onClick={() => (collapsed ? setExpanded(true) : collapse())}>
          {collapsed ? SHOW_ALL : COLLAPSE}
        </button>
      )}
    </div>
  )
})
