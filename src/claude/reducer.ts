// Редьюсер событий `claude -p --output-format stream-json`: строки stdout → лента, агенты, метаданные.
// Чистая логика: входное состояние не мутируется, любой мусор игнорируется.
import { actionTitle, modelLabel, nowLabel } from './labels'

export { actionTitle, modelLabel, nowLabel }

export type FeedClaudeItem =
  | { type: 'user'; text: string }
  | { type: 'assistant'; agentId: string; text: string; streaming: boolean }
  | {
      type: 'action'
      agentId: string
      toolUseId: string
      tool: string
      title: string
      detail: string
      diff?: { before: string; after: string; path: string }
      status: 'running' | 'done' | 'error'
      result?: string
    }
  | { type: 'summary'; text: string; durationMs: number; costUsd: number; isError: boolean }
  | { type: 'error'; text: string }
  /** Начало новой сессии Claude: каталог, в котором она работает. */
  | { type: 'session'; cwd: string }

export interface Agent {
  id: string // 'main' | toolUseId
  parentId: string | null
  name: string
  model: string | null
  status: 'running' | 'waiting' | 'done' | 'error'
  now: string
  history: string[]
  step: { n: number; m: number } | null
  startedAt: number
  endedAt: number | null
  /** in + cache + out последнего ответа агента */
  tokens: number
}

export interface ClaudeState {
  sessionId: string | null
  model: string | null
  contextUsed: number
  contextMax: number
  costUsd: number
  busy: boolean
  /** Отправленные и ещё не завершённые ходы (сообщения в очереди claude); busy = pending > 0. */
  pending: number
  items: FeedClaudeItem[]
  agents: Agent[]
  /** агент, чьё событие пришло последним; null, пока ничего не идёт */
  currentAgentId: string | null
}

const MAIN = 'main'
const DEFAULT_CONTEXT_MAX = 200000
const HISTORY_LIMIT = 50

type Rec = Record<string, unknown>
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const strOr = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d)

function newAgent(id: string, parentId: string | null, name: string, now: number): Agent {
  return {
    id,
    parentId,
    name,
    model: null,
    status: 'running',
    now: '',
    history: [],
    step: null,
    startedAt: now,
    endedAt: null,
    tokens: 0,
  }
}

export function initialClaude(): ClaudeState {
  return {
    sessionId: null,
    model: null,
    contextUsed: 0,
    contextMax: DEFAULT_CONTEXT_MAX,
    costUsd: 0,
    busy: false,
    pending: 0,
    items: [],
    agents: [{ ...newAgent(MAIN, null, 'Главный', 0), status: 'waiting' }],
    currentAgentId: null,
  }
}

function patchAgent(s: ClaudeState, id: string, patch: Partial<Agent> | ((a: Agent) => Partial<Agent>)): ClaudeState {
  return {
    ...s,
    agents: s.agents.map((a) => (a.id === id ? { ...a, ...(typeof patch === 'function' ? patch(a) : patch) } : a)),
  }
}

function ensureAgent(s: ClaudeState, id: string, now: number): ClaudeState {
  if (s.agents.some((a) => a.id === id)) return s
  return { ...s, agents: [...s.agents, newAgent(id, MAIN, 'Агент', now)] }
}

export function userSent(s: ClaudeState, text: string, now: number): ClaudeState {
  const next: ClaudeState = {
    ...s,
    busy: true,
    pending: s.pending + 1,
    currentAgentId: MAIN,
    items: [...s.items, { type: 'user', text }],
  }
  return patchAgent(next, MAIN, { status: 'running', startedAt: now, endedAt: null, now: 'Думает' })
}

function parse(line: string | object): Rec | null {
  if (typeof line !== 'string') return isRec(line) ? line : null
  try {
    const v: unknown = JSON.parse(line)
    return isRec(v) ? v : null
  } catch {
    return null
  }
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => (isRec(b) && typeof b.text === 'string' ? b.text : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

function streamingIndex(items: FeedClaudeItem[], agentId: string): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (it.type === 'assistant' && it.agentId === agentId && it.streaming) return i
  }
  return -1
}

function withModel(s: ClaudeState, aid: string, model: string): ClaudeState {
  if (!model) return s
  let next = patchAgent(s, aid, (a) => (a.model ? {} : { model }))
  if (aid === MAIN && !next.model) next = { ...next, model }
  return next
}

function onDelta(s: ClaudeState, aid: string, text: string, now: number): ClaudeState {
  if (!text) return s
  let next = ensureAgent(s, aid, now)
  const idx = streamingIndex(next.items, aid)
  const items = next.items.slice()
  if (idx >= 0) {
    const it = items[idx]
    if (it.type === 'assistant') items[idx] = { ...it, text: it.text + text }
  } else {
    items.push({ type: 'assistant', agentId: aid, text, streaming: true })
  }
  next = { ...next, items, currentAgentId: aid }
  return next
}

function diffOf(tool: string, i: Rec): { before: string; after: string; path: string } | undefined {
  const path = strOr(i.file_path)
  if (tool === 'Edit') return { before: strOr(i.old_string), after: strOr(i.new_string), path }
  if (tool === 'Write') return { before: '', after: strOr(i.content), path }
  if (tool === 'MultiEdit' && Array.isArray(i.edits)) {
    const edits = i.edits.filter(isRec)
    return {
      before: edits.map((e) => strOr(e.old_string)).join('\n'),
      after: edits.map((e) => strOr(e.new_string)).join('\n'),
      path,
    }
  }
  return undefined
}

function onToolUse(s: ClaudeState, aid: string, block: Rec, now: number): ClaudeState {
  const id = strOr(block.id)
  const tool = strOr(block.name)
  if (!id || !tool) return s
  const input = isRec(block.input) ? block.input : {}
  const label = nowLabel(tool, input)
  let next = s

  if (!next.items.some((it) => it.type === 'action' && it.toolUseId === id)) {
    const { title, detail } = actionTitle(tool, input)
    const diff = diffOf(tool, input)
    next = {
      ...next,
      items: [
        ...next.items,
        { type: 'action', agentId: aid, toolUseId: id, tool, title, detail, ...(diff ? { diff } : {}), status: 'running' },
      ],
    }
  }

  next = patchAgent(next, aid, (a) => {
    const patch: Partial<Agent> = { now: label, history: [...a.history, label].slice(-HISTORY_LIMIT) }
    if (tool === 'AskUserQuestion') patch.status = 'waiting'
    if (tool === 'TodoWrite' && Array.isArray(input.todos)) {
      const todos = input.todos.filter(isRec)
      const m = todos.length
      if (m > 0) {
        const done = todos.filter((t) => t.status === 'completed').length
        patch.step = { n: Math.min(done + 1, m), m }
      }
    }
    return patch
  })

  if (tool === 'Task' || tool === 'Agent') {
    const name = strOr(input.description) || 'Агент'
    if (next.agents.some((a) => a.id === id)) {
      next = patchAgent(next, id, { name, parentId: aid })
    } else {
      next = { ...next, agents: [...next.agents, newAgent(id, aid, name, now)] }
    }
  }
  return next
}

function onAssistant(s: ClaudeState, ev: Rec, now: number): ClaudeState {
  const aid = typeof ev.parent_tool_use_id === 'string' ? ev.parent_tool_use_id : MAIN
  const msg = ev.message
  if (!isRec(msg)) return s
  let next = ensureAgent(s, aid, now)
  next = { ...next, currentAgentId: aid }
  next = withModel(next, aid, strOr(msg.model))

  if (isRec(msg.usage)) {
    const u = msg.usage
    const ctx = num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens)
    next = patchAgent(next, aid, { tokens: ctx + num(u.output_tokens) })
    if (aid === MAIN) next = { ...next, contextUsed: ctx }
  }

  const content = Array.isArray(msg.content) ? msg.content : []
  for (const b of content) {
    if (!isRec(b)) continue
    if (b.type === 'text') {
      const text = strOr(b.text)
      if (!text) continue
      const idx = streamingIndex(next.items, aid)
      const items = next.items.slice()
      if (idx >= 0) items[idx] = { type: 'assistant', agentId: aid, text, streaming: false }
      else items.push({ type: 'assistant', agentId: aid, text, streaming: false })
      next = { ...next, items }
    } else if (b.type === 'tool_use') {
      next = onToolUse(next, aid, b, now)
    }
  }
  return next
}

function onUser(s: ClaudeState, ev: Rec, now: number): ClaudeState {
  const msg = ev.message
  if (!isRec(msg) || !Array.isArray(msg.content)) return s
  let next = s
  for (const b of msg.content) {
    if (!isRec(b) || b.type !== 'tool_result') continue
    const id = strOr(b.tool_use_id)
    if (!id) continue
    const isError = b.is_error === true
    const status = isError ? 'error' : 'done'
    const result = resultText(b.content)
    let actionAgent: string | null = null
    next = {
      ...next,
      items: next.items.map((it) => {
        if (it.type === 'action' && it.toolUseId === id) {
          actionAgent = it.agentId
          return { ...it, status, result } as FeedClaudeItem
        }
        return it
      }),
    }
    if (next.agents.some((a) => a.id === id)) {
      next = patchAgent(next, id, { status, endedAt: now, now: isError ? 'Ошибка' : 'Готово' })
    }
    if (actionAgent) {
      next = patchAgent(next, actionAgent, (a) => (a.status === 'waiting' ? { status: 'running' } : {}))
    }
  }
  return next
}

function onResult(s: ClaudeState, ev: Rec, now: number): ClaudeState {
  const isError = ev.is_error === true
  const cost = typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : s.costUsd
  let contextMax = s.contextMax
  if (isRec(ev.modelUsage)) {
    const windows = Object.values(ev.modelUsage)
      .map((u) => (isRec(u) ? num(u.contextWindow) : 0))
      .filter((w) => w > 0)
    if (windows.length) contextMax = Math.max(...windows)
  }
  const items: FeedClaudeItem[] = s.items.map((it) =>
    it.type === 'assistant' && it.streaming ? { ...it, streaming: false } : it,
  )
  items.push({ type: 'summary', text: strOr(ev.result), durationMs: num(ev.duration_ms), costUsd: cost, isError })
  // Ход закончен: его незавершённые действия и субагенты больше не идут.
  const closed: FeedClaudeItem[] = items.map((it) =>
    it.type === 'action' && it.status === 'running' ? { ...it, status: isError ? 'error' : 'done' } : it,
  )
  const pending = Math.max(0, s.pending - 1)
  let next: ClaudeState = {
    ...s,
    items: closed,
    pending,
    busy: pending > 0,
    costUsd: cost,
    contextMax,
    sessionId: strOr(ev.session_id) || s.sessionId,
    currentAgentId: pending > 0 ? MAIN : null,
    agents: s.agents.map((a) =>
      a.id !== MAIN && (a.status === 'running' || a.status === 'waiting')
        ? { ...a, status: isError ? 'error' : 'done', endedAt: now, now: isError ? 'Ошибка' : 'Готово' }
        : a,
    ),
  }
  // В очереди ещё сообщение — главный агент продолжает (следующий ход), «закончил» не наступает.
  if (pending > 0) return patchAgent(next, MAIN, { status: 'running', now: 'Думает' })
  next = patchAgent(next, MAIN, { status: isError ? 'error' : 'done', endedAt: now, now: isError ? 'Ошибка' : 'Готово' })
  return next
}

export function reduceClaude(s: ClaudeState, line: string | object, now: number): ClaudeState {
  const ev = parse(line)
  if (!ev) return s
  try {
    switch (ev.type) {
      case 'system':
        if (ev.subtype === 'init') {
          const model = strOr(ev.model) || s.model
          let next: ClaudeState = { ...s, sessionId: strOr(ev.session_id) || s.sessionId, model }
          if (model) next = patchAgent(next, MAIN, { model })
          return next
        }
        return s
      case 'stream_event': {
        const e = ev.event
        if (!isRec(e)) return s
        const aid = typeof ev.parent_tool_use_id === 'string' ? ev.parent_tool_use_id : MAIN
        if (e.type === 'message_start' && isRec(e.message)) {
          return withModel(ensureAgent(s, aid, now), aid, strOr(e.message.model))
        }
        if (e.type === 'content_block_delta' && isRec(e.delta) && e.delta.type === 'text_delta') {
          return onDelta(s, aid, strOr(e.delta.text), now)
        }
        return s
      }
      case 'assistant':
        return onAssistant(s, ev, now)
      case 'user':
        return onUser(s, ev, now)
      case 'result':
        return onResult(s, ev, now)
      default:
        return s
    }
  } catch {
    return s
  }
}
