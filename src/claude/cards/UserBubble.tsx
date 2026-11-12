import { memo } from 'react'
import { segments } from '../../attach/doc'
import { Token } from '../../attach/tokenView'
import type { Attachment } from '../../attach/types'

/**
 * Вопрос пользователя: пузырь справа (макет 04, .you). Значки вложений — на своих местах в тексте
 * (макет 06, сцена Д), из сохранённых значков, а не разбором текста.
 */
export const UserBubble = memo(function UserBubble({ text, tokens, id }: { text: string; tokens?: Attachment[]; id?: string }) {
  return (
    <div className={tokens && tokens.length > 0 ? 'you tks' : 'you'} data-item-id={id}>
      <div className="who">Вы</div>
      <span className="you-text">
        {tokens && tokens.length > 0
          ? segments({ text, tokens }).map((s, i) => (s.type === 'text' ? s.text : <Token key={s.token.id + i} token={s.token} />))
          : text}
      </span>
    </div>
  )
})
