// Запрос разрешения инструмента над строкой ввода (тот же блок AgentPrompt, что у вопросов):
// инструмент и всё, что будет разрешено (полная команда, запись и правка построчно, весь ввод
// незнакомого инструмента), варианты: разрешить, разрешить всегда (если CLI предложил правила —
// они показаны), запретить. Невидимые символы — видимыми метками (neutralize).
import { forwardRef, useEffect, useState } from 'react'
import { AgentPrompt } from './AgentPrompt'
import { agentSignature } from './cards/AssistantCard'
import { alwaysLabel, permissionView, suggestionLines, type ViewLine } from './questions'
import type { Agent, FeedClaudeItem, PermissionDecision } from './reducer'

type PermissionItem = Extract<FeedClaudeItem, { type: 'permission' }>

export const PERMISSION_KEYS = '↑↓ 1–3 выбрать · ↵ ответить · esc к вводу'

/**
 * Сколько после появления запрос не принимает ↵ и щелчок: ↵, нажатый ради строки ввода в момент,
 * когда запрос забрал фокус, не должен его разрешить.
 */
export const ARM_MS = 400

export function permissionOptions(item: PermissionItem): { decision: PermissionDecision; label: string }[] {
  return [
    { decision: 'allow', label: 'Разрешить' },
    ...(item.suggestions ? [{ decision: 'always' as const, label: alwaysLabel(item.suggestions) }] : []),
    { decision: 'deny', label: 'Запретить' },
  ]
}

const MARK: Record<ViewLine['k'], string> = { a: '+ ', d: '- ', n: '' }

export interface PermissionPromptProps {
  item: PermissionItem
  agent?: Agent
  onDecide(decision: PermissionDecision): void
  onLeave(): void
}

export const PermissionPrompt = forwardRef<HTMLDivElement, PermissionPromptProps>(function PermissionPrompt(p, ref) {
  const opts = permissionOptions(p.item)
  const [cur, setCur] = useState(0)
  // Блок монтируется на каждый запрос (key = requestId в TerminalPane): отсчёт — с появления.
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setArmed(true), ARM_MS)
    return () => clearTimeout(t)
  }, [])
  const view = permissionView(p.item.tool, p.item.input)
  const rules = p.item.suggestions ? suggestionLines(p.item.suggestions) : []
  const decide = (d: PermissionDecision) => {
    if (armed) p.onDecide(d)
  }
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const n = opts.length
    let handled = true
    if (e.key === 'ArrowDown') setCur((cur + 1) % n)
    else if (e.key === 'ArrowUp') setCur((cur - 1 + n) % n)
    else if (/^[1-9]$/.test(e.key) && Number(e.key) <= n) setCur(Number(e.key) - 1)
    else if (e.key === 'Enter') decide(opts[cur].decision)
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
        {view.target && <code className="p-main">{view.target}</code>}
        {view.facts.length > 0 && <span className="p-detail">{view.facts.join(' · ')}</span>}
      </div>
      {view.code && <pre className="p-code">{view.code}</pre>}
      {view.lines.length > 0 && (
        <div className="diff p-code">
          {view.lines.map((l, i) => (
            <div key={i} className={l.k}>
              {MARK[l.k] + l.t}
            </div>
          ))}
          {view.more > 0 && <span className="n diff-more">… ещё {view.more} строк — не показаны, но входят в разрешение</span>}
        </div>
      )}
      {view.extra && (
        <>
          <div className="p-note">ещё поля ввода:</div>
          <pre className="p-code">{view.extra}</pre>
        </>
      )}
      {view.agentNote && <div className="p-note p-agent">со слов агента: {view.agentNote}</div>}
      {rules.length > 0 && (
        <div className="p-note p-rules">
          «{alwaysLabel(p.item.suggestions ?? [])}» добавит:
          <ul>
            {rules.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}
      <div className={'q-opts' + (armed ? '' : ' p-wait')} role="listbox">
        {opts.map((o, i) => (
          <div
            key={o.decision}
            role="option"
            aria-selected={i === cur}
            aria-disabled={!armed}
            className={'q-row' + (i === cur ? ' sel' : '') + (o.decision === 'deny' ? ' p-deny' : '')}
            // Фокус остаётся, где был; решение — по отпусканию (click), а не по нажатию.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              if (!armed) return
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
