import { memo } from 'react'

/** Ошибка сессии (claude не найден, упал и т. п.): карточка с рамкой --del. */
export const ErrorCard = memo(function ErrorCard({ text, id }: { text: string; id?: string }) {
  return (
    <div className="card cerr" data-item-id={id}>
      <div className="who">✕ Ошибка</div>
      <p className="cerr-text">{text}</p>
    </div>
  )
})
