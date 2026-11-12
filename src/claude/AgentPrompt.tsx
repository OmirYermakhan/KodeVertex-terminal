// Блок «агент ждёт вас» над строкой ввода (в .dock, между панелью агентов и полем): вопросы агента,
// а в будущем — запросы разрешений. Общая рамка: --panel, полоса --warn слева, подпись и подсказка клавиш.
import { forwardRef, type ReactNode } from 'react'

export interface AgentPromptProps {
  /** «? Вопрос · Главный · Opus 5.5» (моно, заглавные, --warn). */
  title: string
  /** Справа в заголовке (например, «1 из 3»). */
  aside?: ReactNode
  /** Подсказка клавиш внизу (как .dh панели агентов). */
  keys: string
  label: string
  onKeyDown?(e: React.KeyboardEvent<HTMLDivElement>): void
  children: ReactNode
}

export const AgentPrompt = forwardRef<HTMLDivElement, AgentPromptProps>(function AgentPrompt(p, ref) {
  return (
    <div className="aprompt" ref={ref} tabIndex={0} role="group" aria-label={p.label} onKeyDown={p.onKeyDown}>
      <div className="ap-h">
        <span className="ap-who">{p.title}</span>
        {p.aside && <span className="ap-aside">{p.aside}</span>}
      </div>
      <div className="ap-body">{p.children}</div>
      <div className="ap-keys">{p.keys}</div>
    </div>
  )
})

export default AgentPrompt
