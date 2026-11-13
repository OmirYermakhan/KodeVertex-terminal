import { memo } from 'react'
import { formatDuration } from '../../feed/feed'
import { formatCost } from '../../format'
import { Markdown } from '../Markdown'

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
  /** Нет — стоимость хода неизвестна (первый ход после `/resume` без записи стоимости): только время. */
  costUsd?: number
  isError: boolean
  id?: string
}) {
  return (
    <div className={isError ? 'sum err' : 'sum'} data-item-id={id}>
      <div className="who">
        {/* Ответ уже в карточке выше — итог одной строкой: «✓ Готово · время · цена». */}
        <span>{text ? (isError ? '✕ Итог' : '✓ Итог') : isError ? '✕ Ошибка' : '✓ Готово'}</span>
        <span className="sum-meta">
          {formatDuration(durationMs)}
          {costUsd !== undefined && ` · ${formatCost(costUsd)}`}
        </span>
      </div>
      {text && <Markdown text={text} />}
    </div>
  )
})
