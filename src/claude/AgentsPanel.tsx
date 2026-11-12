// Панель агентов над строкой ввода (макет 04-main-window `.dh/.row/.detail`): кто из агентов
// Claude-сессии панели работает, ждёт или закончил; ↑↓ — выбор, ↵ — подробности, esc — назад к вводу.
import { forwardRef, Fragment, useEffect, useImperativeHandle, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { modelLabel, type Agent, type ClaudeState } from './reducer'

export const AGENTS_KEYS = '↑↓ выбрать · ↵ подробно · esc назад к вводу · ⌘J скрыть'

/** Время агента: всегда `Nм NNс` (18 с → `0м 18с`). */
export function agentElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(total / 60)}м ${String(total % 60).padStart(2, '0')}с`
}

/** Токены: `51k`; меньше тысячи — как есть. */
export function tokensLabel(t: number): string {
  return t >= 1000 ? `${Math.round(t / 1000)}k` : String(t)
}

export const isFable = (model: string | null | undefined) => !!model && model.toLowerCase().includes('fable')

function plural(n: number, one: string, few: string, many: string): string {
  const d = n % 10
  const dd = n % 100
  if (d === 1 && dd !== 11) return one
  if (d >= 2 && d <= 4 && (dd < 12 || dd > 14)) return few
  return many
}

export function agentsHeader(agents: Agent[]): { running: string; rest: string[] } {
  const count = (s: Agent['status']) => agents.filter((a) => a.status === s).length
  const r = count('running')
  const w = count('waiting')
  const d = count('done')
  const e = count('error')
  const rest = [`${w} ${plural(w, 'ждёт', 'ждут', 'ждут')}`, `${d} ${plural(d, 'готов', 'готовы', 'готовы')}`]
  if (e > 0) rest.push(`${e} ${plural(e, 'ошибка', 'ошибки', 'ошибок')}`)
  return { running: `${r} ${plural(r, 'работает', 'работают', 'работают')}`, rest }
}

/** Порядок строк: дерево (дети сразу под родителем), корни — в порядке появления. */
export function agentRows(agents: Agent[]): { agent: Agent; depth: number }[] {
  const ids = new Set(agents.map((a) => a.id))
  const out: { agent: Agent; depth: number }[] = []
  const seen = new Set<string>()
  const walk = (a: Agent, depth: number) => {
    if (seen.has(a.id)) return
    seen.add(a.id)
    out.push({ agent: a, depth })
    for (const c of agents) if (c.parentId === a.id) walk(c, depth + 1)
  }
  for (const a of agents) if (a.parentId === null || !ids.has(a.parentId)) walk(a, 0)
  // Циклы parentId (мусор в событиях) — всё равно показать.
  for (const a of agents) walk(a, 0)
  return out
}

/** «Читает form.css» → «Читает <b>form.css</b>»: первое слово — действие, остальное — объект. */
function Now({ text }: { text: string }) {
  const i = text.indexOf(' ')
  if (i < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, i + 1)}
      <b>{text.slice(i + 1)}</b>
    </>
  )
}

const PAST: [string, string][] = [
  ['Читает', 'прочитал'],
  ['Пишет', 'записал'],
  ['Запускает', 'запустил'],
  ['Ищет', 'искал'],
  ['Открывает', 'открыл'],
  ['Обновляет', 'обновил'],
  ['Использует', 'использовал'],
  ['Ждёт', 'дождался'],
]

/** Сделанный шаг из history: «Читает Order.kt» → «прочитал Order.kt». */
export function pastLabel(label: string): string {
  for (const [now, past] of PAST) if (label === now || label.startsWith(now + ' ')) return past + label.slice(now.length)
  return label.charAt(0).toLowerCase() + label.slice(1)
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1)

const DETAIL_DONE = 3

function Detail({ agent }: { agent: Agent }) {
  const live = agent.status === 'running' || agent.status === 'waiting'
  const hist = live && agent.history[agent.history.length - 1] === agent.now ? agent.history.slice(0, -1) : agent.history
  const done = hist.slice(-DETAIL_DONE)
  const step = agent.step ? `шаг ${agent.step.n} из ${agent.step.m}` : null
  const lines: ReactNode[] = []
  if (live && agent.now) {
    lines.push(
      <Fragment key="now">
        <span className="now">→ сейчас:</span> <Now text={lowerFirst(agent.now)} />
      </Fragment>,
    )
  }
  done.forEach((h, i) => {
    const last = i === done.length - 1
    lines.push(
      <Fragment key={`h${i}`}>
        ✓ {pastLabel(h)}
        {last && step ? ` · ${step}` : ''}
      </Fragment>,
    )
  })
  if (done.length === 0 && step) lines.push(<Fragment key="step">{step}</Fragment>)
  if (lines.length === 0) lines.push(<Fragment key="empty">{agent.now || 'Пока ничего не сделано'}</Fragment>)
  return (
    <div className="detail" data-testid="agent-detail">
      {lines.map((l, i) => (
        <Fragment key={i}>
          {i > 0 && <br />}
          {l}
        </Fragment>
      ))}
    </div>
  )
}

const DOT: Record<Agent['status'], string> = { running: 'run', waiting: 'wait', done: 'done', error: 'err' }

function Row(p: { agent: Agent; depth: number; now: number; focus: boolean; expanded: boolean; onClick(): void }) {
  const { agent, depth, now, focus, onClick } = p
  const end = agent.status === 'done' || agent.status === 'error' ? (agent.endedAt ?? now) : now
  const elapsed = agent.startedAt > 0 ? agentElapsed(end - agent.startedAt) : '—'
  // Шаг плана — в строке; у раскрытой строки он в подробностях («шаг N из M»).
  const step = agent.status === 'running' && agent.step && !p.expanded ? ` · ${agent.step.n} из ${agent.step.m}` : ''
  const cls = ['row', depth > 0 && 'sub', focus && 'focus'].filter(Boolean).join(' ')
  return (
    <div className={cls} role="option" aria-selected={focus} data-agent-id={agent.id} onClick={onClick}>
      <span className={`s ${DOT[agent.status]}`} />
      <span className="n" style={depth > 1 ? ({ '--depth': depth } as CSSProperties) : undefined}>
        {agent.name}
      </span>
      {agent.model ? <span className={isFable(agent.model) ? 'm f' : 'm'}>{modelLabel(agent.model)}</span> : <span />}
      <span className={`w ${agent.status}`}>
        {agent.status === 'waiting' || agent.status === 'error' ? agent.now : <Now text={agent.now} />}
        {step}
      </span>
      <span className="r">{elapsed}</span>
      <span className="r">{tokensLabel(agent.tokens)}</span>
    </div>
  )
}

export interface AgentsPanelProps {
  state: ClaudeState
  /** esc: фокус обратно в строку ввода. */
  onExit(): void
  /** Сообщений в очереди (заголовок: «· N в очереди»). */
  queued?: number
  /** Текущее время для тестов; иначе — часы, тикающие раз в секунду, пока кто-то работает. */
  now?: number
}

export interface AgentsPanelHandle {
  /** Фокус в панель: выбирается текущий агент (или первый), если ещё никто не выбран. */
  focus(): void
  /** Выбрать агента (по клику на уведомление), не забирая фокус у ввода. */
  select(id: string): void
}

function useTicker(fixed: number | undefined, live: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (fixed !== undefined || !live) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [fixed, live])
  return fixed ?? now
}

export const AgentsPanel = forwardRef<AgentsPanelHandle, AgentsPanelProps>(function AgentsPanel(p, ref) {
  const rows = agentRows(p.state.agents)
  const [sel, setSel] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  // Начальный «waiting» главного агента (startedAt 0) — не повод тикать.
  const live = p.state.agents.some((a) => (a.status === 'running' || a.status === 'waiting') && a.startedAt > 0)
  const now = useTicker(p.now, live)
  const selected = rows.some((r) => r.agent.id === sel) ? sel : null

  // Выбранная строка (и её подробности) — в видимой области прокручиваемой панели.
  useEffect(() => {
    if (!selected) return
    const row = boxRef.current?.querySelector<HTMLElement>(`[data-agent-id="${CSS.escape(selected)}"]`)
    row?.scrollIntoView?.({ block: 'nearest' })
  }, [selected, open])

  const pick = (id: string | null) => {
    setSel(id)
    if (id !== open) setOpen(null)
  }

  useImperativeHandle(ref, () => ({
    select: (id) => {
      if (rows.some((r) => r.agent.id === id)) pick(id)
    },
    focus: () => {
      if (!rows.some((r) => r.agent.id === sel)) {
        const cur = rows.find((r) => r.agent.id === p.state.currentAgentId) ?? rows[0]
        setSel(cur ? cur.agent.id : null)
      }
      boxRef.current?.focus()
    },
  }))

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const i = rows.findIndex((r) => r.agent.id === selected)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (rows.length === 0) return
      const j = i < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))
      pick(rows[j].agent.id)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (selected) setOpen((o) => (o === selected ? null : selected))
    } else if (e.key === 'Escape') {
      e.preventDefault()
      p.onExit()
    }
  }

  const h = agentsHeader(p.state.agents)
  return (
    <div className="agents" ref={boxRef} tabIndex={-1} role="listbox" aria-label="Агенты" onKeyDown={onKeyDown}>
      <div className="dh">
        <span>
          Агенты · <b>{h.running}</b>
          {h.rest.map((s) => ` · ${s}`).join('')}
          {p.queued ? ` · ${p.queued} в очереди` : ''}
        </span>
        <span className="keys">{AGENTS_KEYS}</span>
      </div>
      {rows.map(({ agent, depth }) => (
        <Fragment key={agent.id}>
          <Row
            agent={agent}
            depth={depth}
            now={now}
            focus={agent.id === selected}
            expanded={open === agent.id && agent.id === selected}
            onClick={() => {
              if (agent.id === selected) setOpen((o) => (o === agent.id ? null : agent.id))
              else pick(agent.id)
              boxRef.current?.focus()
            }}
          />
          {open === agent.id && agent.id === selected && <Detail agent={agent} />}
        </Fragment>
      ))}
    </div>
  )
})
