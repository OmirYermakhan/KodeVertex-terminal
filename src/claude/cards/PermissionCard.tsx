// Запрос разрешения в ленте: пока ждёт — строка «! Ждёт разрешения: …» (сам запрос — в блоке над
// строкой ввода, PermissionPrompt); потом — итог: разрешено / запрещено / отменено.
import { memo } from 'react'
import type { FeedClaudeItem } from '../reducer'
import { permissionSummary } from '../questions'

type PermissionItem = Extract<FeedClaudeItem, { type: 'permission' }>

export function permissionLine(item: PermissionItem): string {
  const { main } = permissionSummary(item.tool, item.input)
  return main ? `${item.tool} · ${main}` : item.tool
}

export function permissionStatus(item: PermissionItem): string {
  if (item.done) {
    if (item.decision === 'deny') return '✕ Запрещено: '
    return item.decision === 'always' ? '✓ Разрешено для сессии: ' : '✓ Разрешено: '
  }
  if (item.cancelled) return item.cancelled === 'exit' ? '✕ Запрос отменён (Claude завершился): ' : '✕ Запрос отменён: '
  return '! Ждёт разрешения: '
}

export const PermissionCard = memo(function PermissionCard({ item, id }: { item: PermissionItem; id?: string }) {
  const cls = !item.done && !item.cancelled ? 'cl-note q-wait' : item.done && item.decision !== 'deny' ? 'cl-note p-ok' : 'cl-note q-cancel'
  return (
    <div className={cls} data-item-id={id}>
      {permissionStatus(item)}
      {permissionLine(item)}
    </div>
  )
})
