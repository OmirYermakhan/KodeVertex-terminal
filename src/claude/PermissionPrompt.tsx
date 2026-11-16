// Запрос разрешения инструмента над строкой ввода (тот же блок AgentPrompt, что у вопросов):
// инструмент и всё, что будет разрешено (полная команда, запись и правка построчно, весь ввод
// незнакомого инструмента), варианты: разрешить, разрешить всегда (если CLI предложил правила —
// они показаны), запретить. Невидимые символы — видимыми метками (neutralize).
import { forwardRef, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
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

/** Клавиши, пока часть разрешаемого не видна: сначала дочитать. */
export const READ_KEYS = 'прокрутите до конца, чтобы разрешить · ␣ листать · ↑↓ выбрать · esc к вводу'

/** Запасная высота строки .p-code (12.5px × 1.5), если стиль не посчитан. */
const LINE_PX = 18.75

/** Сколько строк ниже видимой части блока (0 — всё видно). */
function hiddenLines(el: HTMLElement): number {
  const rest = el.scrollHeight - el.clientHeight - el.scrollTop
  if (rest <= 1) return 0
  const lh = parseFloat(getComputedStyle(el).lineHeight) || LINE_PX
  return Math.max(1, Math.ceil(rest / lh))
}

export const moreLabel = (n: number) => `ещё ${n} ${n % 10 === 1 && n % 100 !== 11 ? 'строка' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'строки' : 'строк'} ↓`

/**
 * Блок с разрешаемым (команда, запись, JSON) со своей прокруткой. Не помещается — под ним «ещё N строк ↓»
 * (щелчок раскрывает целиком), а «Разрешить» ждёт, пока блок не дочитают до конца или не раскроют:
 * хвост длинной команды не уходит в разрешение невиденным.
 */
function CodeBox(p: { id: string; diff?: boolean; onUnread(id: string, unread: boolean): void; scroller(id: string, f: (() => boolean) | null): void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement & HTMLPreElement>(null)
  const [hidden, setHidden] = useState(0)
  const [open, setOpen] = useState(false)
  /** Конец блока уже был виден. */
  const seen = useRef(false)
  const { id, onUnread, scroller } = p
  const measure = useCallback(() => {
    const el = ref.current
    if (!el) return
    const n = open ? 0 : hiddenLines(el)
    if (n === 0) seen.current = true
    setHidden(n)
    onUnread(id, !seen.current)
  }, [id, open, onUnread])
  useLayoutEffect(() => {
    measure()
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [measure])
  useEffect(() => () => onUnread(id, false), [id, onUnread])
  // ␣ в блоке запроса: страница вниз в первом недочитанном блоке.
  useEffect(() => {
    scroller(id, () => {
      const el = ref.current
      if (!el || seen.current) return false
      el.scrollTop += Math.max(LINE_PX, el.clientHeight - LINE_PX)
      measure()
      return true
    })
    return () => scroller(id, null)
  }, [id, scroller, measure])
  const cls = (p.diff ? 'diff p-code' : 'p-code') + (open ? ' p-open' : '')
  return (
    <>
      {p.diff ? (
        <div ref={ref} className={cls} onScroll={measure}>
          {p.children}
        </div>
      ) : (
        <pre ref={ref} className={cls} onScroll={measure}>
          {p.children}
        </pre>
      )}
      {hidden > 0 && (
        <button
          type="button"
          className="p-more"
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            seen.current = true
            setOpen(true)
          }}
        >
          {moreLabel(hidden)}
        </button>
      )}
    </>
  )
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
  // Блок монтируется на каждый запрос (key = requestId в TerminalPane): отсчёт — с появления.
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setArmed(true), ARM_MS)
    return () => clearTimeout(t)
  }, [])
  const view = permissionView(p.item.tool, p.item.input)
  const rules = p.item.suggestions ? suggestionLines(p.item.suggestions) : []
  // Недочитанные блоки (не помещаются, конец ещё не был виден): пока они есть — только «Запретить».
  const [unread, setUnread] = useState<Record<string, boolean>>({})
  const onUnread = useCallback((id: string, v: boolean) => setUnread((u) => (!!u[id] === v ? u : { ...u, [id]: v })), [])
  const scrollers = useRef(new Map<string, () => boolean>())
  const scroller = useCallback((id: string, f: (() => boolean) | null) => {
    if (f) scrollers.current.set(id, f)
    else scrollers.current.delete(id)
  }, [])
  const reading = Object.values(unread).some(Boolean)
  const blocked = (d: PermissionDecision) => !armed || (reading && d !== 'deny')
  const decide = (d: PermissionDecision) => {
    if (!blocked(d)) p.onDecide(d)
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
    else if ((e.key === ' ' || e.key === 'PageDown') && reading) {
      for (const f of scrollers.current.values()) if (f()) break
    } else handled = false
    if (handled) {
      e.preventDefault()
      e.stopPropagation()
    }
  }
  return (
    <AgentPrompt
      ref={ref}
      title={`! Разрешение · ${agentSignature(p.agent)}`}
      keys={reading ? READ_KEYS : PERMISSION_KEYS}
      label={`Разрешить ${p.item.tool}?`}
      onKeyDown={onKeyDown}
    >
      <div className="q-text">
        <span className="p-tool">{p.item.tool}</span>
        {view.target && <code className="p-main">{view.target}</code>}
        {view.facts.length > 0 && <span className="p-detail">{view.facts.join(' · ')}</span>}
      </div>
      {view.code && (
        <CodeBox id="code" onUnread={onUnread} scroller={scroller}>
          {view.code}
        </CodeBox>
      )}
      {view.lines.length > 0 && (
        <CodeBox id="lines" diff onUnread={onUnread} scroller={scroller}>
          {view.lines.map((l, i) => (
            <div key={i} className={l.k}>
              {MARK[l.k] + l.t}
            </div>
          ))}
          {view.more > 0 && <span className="n diff-more">… ещё {view.more} строк — не показаны, но входят в разрешение</span>}
        </CodeBox>
      )}
      {view.extra && (
        <>
          <div className="p-note">ещё поля ввода:</div>
          <CodeBox id="extra" onUnread={onUnread} scroller={scroller}>
            {view.extra}
          </CodeBox>
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
            aria-disabled={blocked(o.decision)}
            className={'q-row' + (i === cur ? ' sel' : '') + (o.decision === 'deny' ? ' p-deny' : '') + (armed && blocked(o.decision) ? ' p-hold' : '')}
            // Фокус остаётся, где был; решение — по отпусканию (click), а не по нажатию.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              if (blocked(o.decision)) return
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
