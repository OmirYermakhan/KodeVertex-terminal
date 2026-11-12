// Редьюсер событий `claude -p --output-format stream-json`: строки stdout → лента, агенты, метаданные.
// Чистая логика: входное состояние не мутируется, любой мусор игнорируется.
import { actionTitle, modelLabel, nowLabel } from './labels'
import { parsePermissionRequest, type Question } from './questions'

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
  /** Тихая моноширинная строка ленты (например, «Модель: Fable 5.2 · усилие high»). */
  | { type: 'note'; text: string }
  /** Вопрос агента с вариантами (AskUserQuestion): ответы по шагам, всё отвечено — done. */
  | {
      type: 'question'
      requestId: string
      toolUseId: string | null
      agentId: string
      questions: Question[]
      /** Исходный ввод инструмента: в ответ уходит он же с `answers`. */
      input: Record<string, unknown>
      step: number
      answers: string[]
      done: boolean
      /** Ответа больше не ждут: exit — процесс завершился; stop — ход прерван/закончен или CLI отменил запрос. */
      cancelled?: CancelReason
    }
  /** Запрос разрешения инструмента (can_use_tool не для вопроса). */
  | {
      type: 'permission'
      requestId: string
      toolUseId: string | null
      agentId: string
      tool: string
      input: Record<string, unknown>
      suggestions: unknown[] | null
      done: boolean
      decision?: PermissionDecision
      cancelled?: CancelReason
    }
  /** Начало новой сессии Claude: каталог, в котором она работает. */
  | { type: 'session'; cwd: string; /** Вход в режим Claude из строки ввода (`claude`): с подсказкой. */ mode?: boolean }

export type PermissionDecision = 'allow' | 'always' | 'deny'
export type CancelReason = 'exit' | 'stop'

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
  /** Применённое усилие (ответ get_settings); null — ещё неизвестно. */
  effort: string | null
  /** `model` из настроек Claude Code (`opus[1m]`); null — не задан или неизвестно. */
  defaultModel: string | null
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
    effort: null,
    defaultModel: null,
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

function onResult(prev: ClaudeState, ev: Rec, now: number): ClaudeState {
  // Ход закончен — его вопросы и запросы разрешений больше не ждут ответа.
  const s = cancelPrompts(prev)
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

/** Ответ на управляющий запрос: set_model → { model }, get_settings → { effective, applied }. */
function onControl(s: ClaudeState, ev: Rec): ClaudeState {
  const r = ev.response
  if (!isRec(r) || r.subtype !== 'success' || !isRec(r.response)) return s
  const body = r.response
  let next = s
  if (isRec(body.applied)) {
    const model = strOr(body.applied.model)
    const effort = strOr(body.applied.effort)
    next = { ...next, ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
    if (isRec(body.effective)) next = { ...next, defaultModel: strOr(body.effective.model) || null }
  } else if (typeof body.model === 'string' && body.model) {
    next = { ...next, model: body.model }
  }
  if (next === s) return s
  return next.model && next.model !== s.model ? patchAgent(next, MAIN, { model: next.model }) : next
}

function onControlRequest(s: ClaudeState, ev: Rec, now: number): ClaudeState {
  const r = parsePermissionRequest(ev)
  if (!r || r.kind === 'deny') return s
  if (s.items.some((it) => (it.type === 'question' || it.type === 'permission') && it.requestId === r.requestId)) return s
  const action = s.items.find((it) => it.type === 'action' && it.toolUseId === r.toolUseId)
  const agentId = action?.type === 'action' ? action.agentId : MAIN
  const next = ensureAgent(s, agentId, now)
  const item: FeedClaudeItem =
    r.kind === 'ask'
      ? { type: 'question', requestId: r.requestId, toolUseId: r.toolUseId, agentId, questions: r.questions, input: r.input, step: 0, answers: [], done: false }
      : { type: 'permission', requestId: r.requestId, toolUseId: r.toolUseId, agentId, tool: r.tool, input: r.input, suggestions: r.suggestions, done: false }
  return patchAgent({ ...next, items: [...next.items, item] }, agentId, {
    status: 'waiting',
    now: r.kind === 'ask' ? 'Ждёт ответа' : 'Ждёт разрешения',
  })
}

type PromptItem = Extract<FeedClaudeItem, { type: 'question' | 'permission' }>
const isPending = (it: FeedClaudeItem): it is PromptItem =>
  (it.type === 'question' || it.type === 'permission') && !it.done && !it.cancelled

/** Первый ждущий ответа запрос агента панели (вопрос или разрешение) — для блока над строкой ввода. */
export function pendingPrompt(s: ClaudeState): PromptItem | null {
  return s.items.find(isPending) ?? null
}

/** Ждущие запросы отменены (все или только requestId): ответа на них больше не ждут. */
export function cancelPrompts(s: ClaudeState, requestId?: string, reason: CancelReason = 'stop'): ClaudeState {
  if (!s.items.some((it) => isPending(it) && (requestId === undefined || it.requestId === requestId))) return s
  return {
    ...s,
    items: s.items.map((it) => (isPending(it) && (requestId === undefined || it.requestId === requestId) ? { ...it, cancelled: reason } : it)),
  }
}

/** Решение по запросу разрешения. */
export function decidePermission(s: ClaudeState, requestId: string, decision: PermissionDecision): ClaudeState {
  const i = s.items.findIndex((it) => it.type === 'permission' && it.requestId === requestId)
  const it = s.items[i]
  if (!it || it.type !== 'permission' || !isPending(it)) return s
  const items = s.items.slice()
  items[i] = { ...it, done: true, decision }
  return { ...s, items }
}

function patchQuestion(
  s: ClaudeState,
  requestId: string,
  f: (q: Extract<FeedClaudeItem, { type: 'question' }>) => Extract<FeedClaudeItem, { type: 'question' }> | null,
): ClaudeState {
  const i = s.items.findIndex((it) => it.type === 'question' && it.requestId === requestId)
  const q = s.items[i]
  if (!q || q.type !== 'question' || q.done || q.cancelled) return s
  const next = f(q)
  if (!next) return s
  const items = s.items.slice()
  items[i] = next
  return { ...s, items }
}

/** Шагов у вопроса: по вопросу на шаг, у нескольких — ещё шаг «Отправить ответы». */
export const questionSteps = (q: { questions: unknown[] }) => (q.questions.length > 1 ? q.questions.length + 1 : 1)

/** Ответ на вопрос index; курсор шага — на следующий (у нескольких вопросов — до шага отправки). */
export function recordAnswer(s: ClaudeState, requestId: string, index: number, answer: string): ClaudeState {
  return patchQuestion(s, requestId, (q) => {
    if (index < 0 || index >= q.questions.length) return null
    const answers = q.questions.map((_, i) => (i === index ? answer : (q.answers[i] ?? '')))
    return { ...q, answers, step: Math.min(index + 1, questionSteps(q) - 1) }
  })
}

/** Перейти к шагу (вкладке) вопроса. */
export function gotoStep(s: ClaudeState, requestId: string, step: number): ClaudeState {
  return patchQuestion(s, requestId, (q) =>
    step < 0 || step >= questionSteps(q) || step === q.step ? null : { ...q, step },
  )
}

/** Все ответы есть — вопрос закрыт (ответ уходит процессу). */
export function finishQuestion(s: ClaudeState, requestId: string): ClaudeState {
  return patchQuestion(s, requestId, (q) =>
    q.questions.every((_, i) => (q.answers[i] ?? '') !== '') ? { ...q, done: true } : null,
  )
}

/** Первый ждущий вопрос (не разрешение). */
export function pendingQuestion(s: ClaudeState): Extract<FeedClaudeItem, { type: 'question' }> | null {
  const p = pendingPrompt(s)
  return p?.type === 'question' ? p : null
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
      case 'control_response':
        return onControl(s, ev)
      case 'control_request':
        return onControlRequest(s, ev, now)
      case 'control_cancel_request':
        return typeof ev.request_id === 'string' ? cancelPrompts(s, ev.request_id) : s
      default:
        return s
    }
  } catch {
    return s
  }
}
