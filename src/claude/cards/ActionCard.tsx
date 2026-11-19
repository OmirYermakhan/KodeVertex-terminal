import { memo, useState } from 'react'
import { modelLabel } from '../labels'
import type { Agent, FeedClaudeItem } from '../reducer'
import { DiffView } from './DiffView'

const LONG = 120

type Action = Extract<FeedClaudeItem, { type: 'action' }>
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

function shortResult(result: string | undefined): string {
  const line = (result ?? '').split('\n').find((l) => l.trim()) ?? ''
  const t = line.trim()
  return t.length > 80 ? t.slice(0, 79) + '…' : t
}

/** Действие агента (макет 02 B / 04, .act): пунктирная рамка, подпись --info, деталь моноширинным. */
export const ActionCard = memo(function ActionCard({ item, agent, id, cwd }: { item: Action; agent: Agent | undefined; id?: string; cwd?: string | null }) {
  const icon = EDIT_TOOLS.has(item.tool) || item.diff ? '✎' : '▶'
  // Субагент: подпись — «Имя · Модель» (макет 04 «▶ Поиск · Haiku 5.5»), название действия уходит в тело.
  const isSub = !!agent && agent.id !== 'main'
  const label = isSub ? (agent.model ? `${agent.name} · ${modelLabel(agent.model)}` : agent.name) : item.title
  const running = item.status === 'running'
  // Правка файла: путь — в заголовке вида изменений, «файл обновлён» не повторяем (ошибку — да).
  const diff = item.diff && item.status !== 'error' ? item.diff : undefined
  const res = running || diff ? '' : shortResult(item.result)
  const detail = diff ? '' : item.detail
  // Длинная/многострочная деталь (heredoc, цепочка команд) — свёрнута в одну строку, раскрывается кликом.
  const long = detail.length > LONG || detail.includes('\n')
  const [open, setOpen] = useState(false)
  const clip = long && !open
  const cls = ['act', running && 'run', item.status === 'error' && 'fail', long && 'long', clip && 'clip'].filter(Boolean).join(' ')
  const toggle = () => {
    // Выделение текста мышью не должно сворачивать карточку.
    if (window.getSelection()?.toString()) return
    setOpen((v) => !v)
  }
  const body = (
    <>
      {isSub && item.title}
      {isSub && detail && ' '}
      {detail && <b>{clip ? detail.replace(/\s+/g, ' ') : detail}</b>}
      {res && (
        <>
          {/* Результат — после тире, как в макете 04: «Нашёл Form.tsx:42 — обработчик кнопки». */}
          {(detail || isSub) && ' — '}
          {res}
        </>
      )}
    </>
  )
  return (
    <div className={cls} data-item-id={id} onClick={long ? toggle : undefined} title={clip ? 'Показать полностью' : undefined}>
      <div className="who">
        {icon} {label}
        {long && <span className="act-tg" aria-hidden="true">{open ? '▾' : '▸'}</span>}
      </div>
      {long ? <div className="act-body">{body}</div> : body}
      {diff && <DiffView diff={diff} cwd={cwd} />}
      {running && (
        <div className="act-now">
          <span className="spin" aria-hidden="true" />
          Сейчас выполняю…
        </div>
      )}
    </div>
  )
})
