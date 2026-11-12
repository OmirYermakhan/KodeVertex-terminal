// Запрос разрешения инструмента над строкой ввода (тот же блок AgentPrompt, что у вопросов):
// инструмент и понятное описание (команда, путь, размер правки), варианты: разрешить,
// разрешить всегда для сессии (если CLI предложил правило), запретить.
import { forwardRef, useState } from 'react'
import { AgentPrompt } from './AgentPrompt'
import { agentSignature } from './cards/AssistantCard'
import { permissionSummary } from './questions'
import type { Agent, FeedClaudeItem, PermissionDecision } from './reducer'

type PermissionItem = Extract<FeedClaudeItem, { type: 'permission' }>

export const PERMISSION_KEYS = '↑↓ 1–3 выбрать · ↵ ответить · esc к вводу'

export function permissionOptions(item: PermissionItem): { decision: PermissionDecision; label: string }[] {
  return [
    { decision: 'allow', label: 'Разрешить' },
    ...(item.suggestions ? [{ decision: 'always' as const, label: 'Разрешить всегда для этой сессии' }] : []),
    { decision: 'deny', label: 'Запретить' },
  ]
}

export interface PermissionPromptProps {
  item: PermissionItem
  agent?: Agent
  onDecide(decision: PermissionDecision): void
  onLeave(): void
}

export const PermissionPrompt = forwardRef<HTMLDivElement, PermissionPromptProps>(function PermissionPrompt(p, ref) {
  const opts = permissionOptions(p.item)
  const [cur, setCur] = useState(0)
  const { main, detail } = permissionSummary(p.item.tool, p.item.input)
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const n = opts.length
    let handled = true
    if (e.key === 'ArrowDown') setCur((cur + 1) % n)
    else if (e.key === 'ArrowUp') setCur((cur - 1 + n) % n)
    else if (/^[1-9]$/.test(e.key) && Number(e.key) <= n) setCur(Number(e.key) - 1)
    else if (e.key === 'Enter') p.onDecide(opts[cur].decision)
    else if (e.key === 'Escape') p.onLeave()
    else handled = false
    if (handled) {
      e.preventDefault()
      e.stopPropagation()
    }
  }
  return (
    <AgentPrompt
      ref={ref}
      title={`! Разрешение · ${agentSignature(p.agent)}`}
      keys={PERMISSION_KEYS}
      label={`Разрешить ${p.item.tool}?`}
      onKeyDown={onKeyDown}
    >
      <div className="q-text">
        <span className="p-tool">{p.item.tool}</span>
        {main && <code className="p-main">{main}</code>}
        {detail && <span className="p-detail">{detail}</span>}
      </div>
      <div className="q-opts" role="listbox">
        {opts.map((o, i) => (
          <div
            key={o.decision}
            role="option"
            aria-selected={i === cur}
            className={'q-row' + (i === cur ? ' sel' : '') + (o.decision === 'deny' ? ' p-deny' : '')}
            onMouseDown={(e) => {
              e.preventDefault()
              setCur(i)
              p.onDecide(o.decision)
            }}
          >
            <span className="q-n">{i + 1}.</span>
            <span className="q-l">{o.label}</span>
            <span className="q-d" />
          </div>
        ))}
      </div>
    </AgentPrompt>
  )
})

export default PermissionPrompt
