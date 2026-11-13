import { memo } from 'react'
import { usePreviewApi } from '../../attach/preview/usePreview'
import { segments } from '../../attach/doc'
import { Token } from '../../attach/tokenView'
import type { Attachment } from '../../attach/types'
import { HoverActions } from '../../feed/ShellBlockView'

/**
 * Вопрос пользователя: пузырь справа (макет 04, .you). Значки вложений — на своих местах в тексте
 * (макет 06, сцена Д), из сохранённых значков, а не разбором текста.
 * onEdit — «✎ Изменить» в панельке при наведении (только у сообщений, которые можно переписать);
 * editing — сообщение сейчас правится в строке ввода (обводка --acc).
 */
export const UserBubble = memo(function UserBubble({
  text,
  tokens,
  id,
  selected,
  editing,
  onEdit,
}: {
  text: string
  tokens?: Attachment[]
  id?: string
  selected?: boolean
  editing?: boolean
  onEdit?(id: string): void
}) {
  // Наведение на значок — тот же мини-просмотр, что в строке ввода (сцена Д).
  const pv = usePreviewApi()
  const onPreview = pv ? (t: Attachment, el: HTMLElement | null) => (el ? pv.hover(t, el, 'bubble') : pv.leave()) : undefined
  const cls = ['you', tokens && tokens.length > 0 && 'tks', selected && 'sel', editing && 'edit'].filter(Boolean).join(' ')
  return (
    <div className={cls} data-item-id={id}>
      {id && !editing && <HoverActions id={id} onEdit={onEdit} />}
      <div className="who">Вы</div>
      <span className="you-text">
        {tokens && tokens.length > 0
          ? segments({ text, tokens }).map((s, i) => (s.type === 'text' ? s.text : <Token key={s.token.id + i} token={s.token} onPreview={onPreview} />))
          : text}
      </span>
    </div>
  )
})
