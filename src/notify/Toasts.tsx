// Тосты справа внизу над статус-баром (26px): панель --panel, рамка --rule, слева полоса цвета статуса.
import { openToast, useToasts } from './notify'

export default function Toasts() {
  const toasts = useToasts((s) => s.toasts)
  if (toasts.length === 0) return null
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <button key={t.id} type="button" className={`toast ${t.kind}`} onClick={() => openToast(t)}>
          {t.text}
        </button>
      ))}
    </div>
  )
}
