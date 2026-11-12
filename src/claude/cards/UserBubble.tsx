import { memo } from 'react'

/** Вопрос пользователя: пузырь справа (макет 04, .you). */
export const UserBubble = memo(function UserBubble({ text, id }: { text: string; id?: string }) {
  return (
    <div className="you" data-item-id={id}>
      <div className="who">Вы</div>
      <span className="you-text">{text}</span>
    </div>
  )
})
