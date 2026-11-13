import { memo } from 'react'
import { modelLabel } from '../labels'
import type { Agent, FeedClaudeItem } from '../reducer'
import { DiffView } from './DiffView'

type Action = Extract<FeedClaudeItem, { type: 'action' }>
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

function shortResult(result: string | undefined): string {
  const line = (result ?? '').split('\n').find((l) => l.trim()) ?? ''
  const t = line.trim()
  return t.length > 80 ? t.slice(0, 79) + '…' : t
}

/** Действие агента (макет 02 B / 04, .act): пунктирная рамка, подпись --info, деталь моноширинным. */
export const ActionCard = memo(function ActionCard({ item, agent, id }: { item: Action; agent: Agent | undefined; id?: string }) {
  const icon = EDIT_TOOLS.has(item.tool) || item.diff ? '✎' : '▶'
  // Субагент: подпись — «Имя · Модель» (макет 04 «▶ Поиск · Haiku 5.5»), название действия уходит в тело.
  const isSub = !!agent && agent.id !== 'main'
  const label = isSub ? (agent.model ? `${agent.name} · ${modelLabel(agent.model)}` : agent.name) : item.title
  const running = item.status === 'running'
  // Правка файла: путь — в заголовке вида изменений, «файл обновлён» не повторяем (ошибку — да).
  const diff = item.diff && item.status !== 'error' ? item.diff : undefined
  const res = running || diff ? '' : shortResult(item.result)
  const detail = diff ? '' : item.detail
  const cls = ['act', running && 'run', item.status === 'error' && 'fail'].filter(Boolean).join(' ')
  return (
    <div className={cls} data-item-id={id}>
      <div className="who">
        {icon} {label}
      </div>
      {isSub && item.title}
      {isSub && detail && ' '}
      {detail && <b>{detail}</b>}
      {res && (
        <>
          {/* Результат — после тире, как в макете 04: «Нашёл Form.tsx:42 — обработчик кнопки». */}
          {(detail || isSub) && ' — '}
          {res}
        </>
      )}
      {diff && <DiffView diff={diff} />}
      {running && (
        <div className="act-now">
          <span className="spin" aria-hidden="true" />
          Сейчас выполняю…
        </div>
      )}
    </div>
  )
})
