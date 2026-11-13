import { memo } from 'react'
import { formatDuration } from '../../feed/feed'
import { Markdown } from '../Markdown'

export function formatCost(usd: number): string {
  if (usd > 0 && usd < 0.01) return `$${usd.toFixed(3)}`
  return `$${usd.toFixed(2)}`
}

/** Итог хода (макет 02, вариант B, .sum): «✓ Итог», время и стоимость; без текста — «✓ Готово». */
export const SummaryCard = memo(function SummaryCard({
  text,
  durationMs,
  costUsd,
  isError,
  id,
}: {
  text: string
  durationMs: number
  costUsd: number
  isError: boolean
  id?: string
}) {
  return (
    <div className={isError ? 'sum err' : 'sum'} data-item-id={id}>
      <div className="who">
        {/* Ответ уже в карточке выше — итог одной строкой: «✓ Готово · время · цена». */}
        <span>{text ? (isError ? '✕ Итог' : '✓ Итог') : isError ? '✕ Ошибка' : '✓ Готово'}</span>
        <span className="sum-meta">
          {formatDuration(durationMs)} · {formatCost(costUsd)}
        </span>
      </div>
      {text && <Markdown text={text} />}
    </div>
  )
})
