// Редьюсер событий `claude -p --output-format stream-json`: строки stdout → лента, агенты, метаданные.
// Чистая логика: входное состояние не мутируется, любой мусор игнорируется.
import { actionTitle, modelLabel, nowLabel } from './labels'
import { parsePermissionRequest, type Question } from './questions'
import type { Attachment } from '../attach/types'
import { ORIGINAL_MAX, parseHunks, type FileDiff } from './diff'

export { actionTitle, modelLabel, nowLabel }

export type FeedClaudeItem =
  /**
   * Сообщение пользователя. Со значками вложений: text — с TOKEN_CHAR на их местах, tokens — по
   * порядку (хранятся как есть, не разбираются из текста: правка сообщения вернёт их в строку).
   * steer — отправлено посреди хода («отправить сейчас»): CLI вставляет его в идущий ход, это не
   * начало хода (границей хода не считается, на правку не берётся).
   */
  | { type: 'user'; text: string; tokens?: Attachment[]; steer?: true }
  | { type: 'assistant'; agentId: string; text: string; streaming: boolean; turn?: { durationMs: number; costUsd?: number } }
  | {
      type: 'action'
      agentId: string
      toolUseId: string
      tool: string
      title: string
      detail: string
      diff?: FileDiff
      status: 'running' | 'done' | 'error'
      result?: string
    }
  /** costUsd нет — стоимость хода неизвестна (см. ClaudeState.costUnknown). */
  /** stopped — ход прервал пользователь (esc/⌃C): «◼ Прервано», не ошибка. */
  | { type: 'summary'; text: string; durationMs: number; costUsd?: number; isError: boolean; stopped?: boolean }
  | { type: 'error'; text: string }
  /**
   * План агента (TodoWrite): одна карточка на агента, каждый следующий TodoWrite обновляет её
   * на месте, а не добавляет новую.
   */
  | { type: 'todo'; agentId: string; toolUseId: string; todos: Todo[]; /** Ушла из ленты (⌃L, /clear): больше не обновляется — следующий TodoWrite добавит новую. */ frozen?: boolean }
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
  /**
   * Прежний вариант разговора после правки сообщения: изменённый пузырь и всё после него — одной
   * свёрнутой строкой на месте пузыря (items — как были, только для чтения; count — сообщений «Вы»).
   */
  | { type: 'replaced'; items: FeedClaudeItem[]; count: number }
  /** Место элемента, ушедшего в «Прежний вариант» (индексы элементов не сдвигаются). */
  | { type: 'gone' }

export type TodoStatus = 'pending' | 'in_progress' | 'completed'
export interface Todo {
  content: string
  status: TodoStatus
  /** Форма «в процессе» («Пишу тесты»), если агент её дал. */
  activeForm?: string
}

const TODO_STATUS = new Set<string>(['pending', 'in_progress', 'completed'])

/** Пункты TodoWrite: без текста — пропускаем, неизвестный статус — «не начат». */
function parseTodos(v: unknown[]): Todo[] {
  const out: Todo[] = []
  for (const t of v) {
    if (!isRec(t)) continue
    const content = strOr(t.content).trim()
    if (!content) continue
    const status = (TODO_STATUS.has(strOr(t.status)) ? t.status : 'pending') as TodoStatus
    const active = strOr(t.activeForm).trim()
    out.push(active ? { content, status, activeForm: active } : { content, status })
  }
  return out
}

/** План агента в ленте: есть карточка — обновить на месте, нет — добавить в конец. */
function upsertTodo(s: ClaudeState, aid: string, toolUseId: string, todos: Todo[]): ClaudeState {
  const idx = s.items.findIndex((it) => it.type === 'todo' && it.agentId === aid && !it.frozen)
  const item: FeedClaudeItem = { type: 'todo', agentId: aid, toolUseId, todos }
  if (idx < 0) return { ...s, items: [...s.items, item] }
  const items = s.items.slice()
  items[idx] = item
  return { ...s, items }
}

/**
 * Лента очищена (⌃L, /clear): карточки плана с индексом < from не видны — их больше не обновляем,
 * следующий TodoWrite покажет план новой карточкой внизу.
 */
export function freezeTodos(s: ClaudeState, from: number): ClaudeState {
  if (!s.items.some((it, i) => i < from && it.type === 'todo' && !it.frozen)) return s
  return { ...s, items: s.items.map((it, i) => (i < from && it.type === 'todo' && !it.frozen ? { ...it, frozen: true } : it)) }
}

export type PermissionDecision = 'allow' | 'always' | 'deny'

/** Сообщение сессии, после которого можно продолжить разговор (`--resume-session-at`). */
export interface RewindPoint {
  session: string
  /** uuid последнего события `assistant` главного агента. */
  uuid: string
}

/**
 * Как переписать отправленное сообщение. at: точка перед ним; 'fresh' — первое сообщение сессии
 * (правка начинает новую сессию); null — точка неизвестна («Изменить» не показываем, не гадаем).
 * epoch — линия сессии: сообщения прежних сессий (другой каталог) не правятся.
 */
export interface EditPoint {
  at: RewindPoint | 'fresh' | null
  epoch: number
}
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
  /**
   * Фоновый агент (Agent с `run_in_background`, `task_started` с `is_backgrounded`): tool_result
   * приходит сразу («запущен»), а работает он дальше — до `task_notification`.
   */
  background?: boolean
  /** id задачи CLI (`task_started`) — для сверки событий task_*. */
  taskId?: string
  /** Вызовов инструментов по `task_progress`. */
  toolUses?: number
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
  /** Стоимость сессии целиком: costBase (завершённые процессы) + costProc (нарастающий итог текущего). */
  costUsd: number
  /**
   * База итога: costUsd = costBase + costProc. Растёт, когда начинается новая сессия без
   * `--resume` (её `total_cost_usd` идёт с нуля, набранное в панели остаётся) или итог процесса
   * вдруг уменьшился (процесс начал счёт с нуля).
   */
  costBase?: number
  /**
   * Нарастающий итог сессии по CLI (`total_cost_usd` последнего result). Процесс с `--resume`
   * (⌘↵ после выхода, перезапуск приложения, правка с `--fork-session`) продолжает его — CLI
   * восстанавливает итог из записей `cost-state` файла разговора (проверено на настоящем CLI).
   */
  costProc?: number
  /**
   * Последний известный нарастающий итог по id сессии (линия правок): ответвление правкой
   * продолжает итог той сессии, от которой ответвляется, а не текущей.
   */
  costOf?: Record<string, number>
  /**
   * Итог сессии до этого процесса неизвестен (`/resume` разговора без записи стоимости): первый
   * result только задаёт costProc, а время хода показывается без цены.
   */
  costUnknown?: boolean
  busy: boolean
  /** Отправленные и ещё не завершённые ходы (сообщения в очереди claude); busy = pending > 0. */
  pending: number
  items: FeedClaudeItem[]
  agents: Agent[]
  /** агент, чьё событие пришло последним; null, пока ничего не идёт */
  currentAgentId: string | null
  /** Последнее сообщение главного агента текущей сессии — точка перемотки для следующего вопроса. */
  chain: RewindPoint | null
  /** Линия сессии: растёт, когда начинается новая сессия (не продолжение и не ответвление). */
  epoch: number
  /** Точки правки сообщений «Вы»: индекс элемента → точка. */
  edits: Record<number, EditPoint>
  /**
   * Подсказка следующего сообщения (`prompt_suggestion` после хода, `--prompt-suggestions`):
   * after — время конца хода, к которому она относится. null — нет (новый ход, отправка, убрана).
   */
  suggestion?: Suggestion | null
  /** Время последнего `result` (конца хода); подсказка относится к нему. */
  turnEndAt?: number
  /**
   * Отправленные посреди хода сообщения, которые CLI ещё не взял в ход. CLI вставляет их после
   * ближайшего tool_result главного агента; если до конца хода инструментов больше нет — они станут
   * следующим ходом (CLI начнёт его сам): тогда result этот ход не закрывает (см. onResult).
   */
  steer?: number
}

export interface Suggestion {
  text: string
  after: number
}

/** Подсказка длиннее не показывается (CLI сам отсекает от 100 символов). */
const SUGGESTION_MAX = 200

/** `prompt_suggestion`: только между ходами (ничего не идёт), одна строка. */
function onSuggestion(s: ClaudeState, ev: Rec): ClaudeState {
  const text = strOr(ev.suggestion).trim()
  if (!text || text.includes('\n') || text.length > SUGGESTION_MAX) return s
  if (s.busy || s.pending > 0 || s.turnEndAt === undefined) return s
  return { ...s, suggestion: { text, after: s.turnEndAt } }
}

/** Подсказку убрали (набор, esc, вставка). */
export function dropSuggestion(s: ClaudeState): ClaudeState {
  return s.suggestion ? { ...s, suggestion: null } : s
}

const MAIN = 'main'
/** До первого `result` окно неизвестно; у моделей семейства 5 (и `[1m]`) — 1 млн токенов. */
const DEFAULT_CONTEXT_MAX = 1_000_000
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
    chain: null,
    epoch: 0,
    edits: {},
  }
}

/**
 * Запуск нового процесса `claude`. resume — id сессии из `--resume` (null — новая сессия).
 * Новая сессия: её `total_cost_usd` начнётся с нуля, набранное в панели уходит в базу.
 * Продолжение: CLI продолжает нарастающий итог этой сессии (у ответвления — итог сессии, от которой
 * оно ответвилось, вместе с её отброшенной частью), так что costProc — последний известный итог
 * этой сессии. Неизвестен (сохранён старой версией) — текущий costProc.
 * Слепое пятно: процесс с `--resume`, который всё же начал счёт с нуля (CLI без `cost-state`),
 * и чей первый ход дороже прежнего итога, читается как продолжение — недосчёт на прежний итог.
 * Начавший с нуля и первым ходом дешевле — правило «итог уменьшился» в onResult.
 */
export function newProcess(s: ClaudeState, resume: string | null = null): ClaudeState {
  if (resume === null) return { ...s, costBase: s.costUsd, costProc: 0, costUnknown: false }
  const known = s.costOf?.[resume]
  if (known === undefined || known === (s.costProc ?? 0)) return s
  return { ...s, costBase: s.costUsd - known, costProc: known }
}

/** Новая сессия (другой каталог, --resume не удался): прежние сообщения больше не правятся. */
export function newSession(s: ClaudeState): ClaudeState {
  return { ...s, sessionId: null, chain: null, epoch: s.epoch + 1, suggestion: null }
}

/**
 * `/clear`: новая сессия с чистого листа — недоигранное закрыто, вопросы и разрешения сняты,
 * агенты и контекст как у новой сессии. Элементы остаются (их скрывает лента), индексы не сдвигаются.
 */
export function clearSession(s: ClaudeState): ClaudeState {
  const fresh = initialClaude()
  const items = closeUnfinished(s.items).map((it): FeedClaudeItem => (it.type === 'todo' && !it.frozen ? { ...it, frozen: true } : it))
  return {
    ...newSession(cancelPrompts({ ...s, items }, undefined, 'stop')),
    busy: false,
    pending: 0,
    ...(s.steer ? { steer: 0 } : {}),
    currentAgentId: null,
    contextUsed: 0,
    costUsd: 0,
    costBase: 0,
    costProc: 0,
    costOf: {},
    costUnknown: false,
    agents: fresh.agents,
    edits: {},
  }
}

/**
 * Недоигранное закрыто: печатающийся ответ дописан, идущее действие — «ошибка». Ход оборвался
 * (ошибка, выход процесса, /clear, правка): иначе следующий ответ допишется в старую карточку.
 * Ничего не идёт — тот же массив.
 */
export function closeUnfinished(items: FeedClaudeItem[]): FeedClaudeItem[] {
  if (!items.some((it) => (it.type === 'assistant' && it.streaming) || (it.type === 'action' && it.status === 'running'))) return items
  return items.map((it): FeedClaudeItem => {
    if (it.type === 'assistant' && it.streaming) return { ...it, streaming: false }
    if (it.type === 'action' && it.status === 'running') return { ...it, status: 'error' }
    return it
  })
}

function patchAgent(s: ClaudeState, id: string, patch: Partial<Agent> | ((a: Agent) => Partial<Agent>)): ClaudeState {
  return {
    ...s,
    agents: s.agents.map((a) => (a.id === id ? { ...a, ...(typeof patch === 'function' ? patch(a) : patch) } : a)),
  }
}

/** Фоновый агент ещё работает (ждёт ответа — тоже работает). */
const bgLive = (a: Agent) => a.background === true && (a.status === 'running' || a.status === 'waiting')

/** Сколько фоновых агентов ещё работает. */
export function backgroundRunning(s: Pick<ClaudeState, 'agents'>): number {
  return s.agents.filter(bgLive).length
}

const isLive = (a: Agent) => a.status === 'running' || a.status === 'waiting'

/**
 * Живые фоновые агенты и все живые агенты под ними (субагент фонового агента тоже переживает ход
 * главного): их result хода не закрывает.
 */
function backgroundTree(agents: readonly Agent[]): Set<string> {
  const out = new Set(agents.filter(bgLive).map((a) => a.id))
  for (let grew = out.size > 0; grew; ) {
    grew = false
    for (const a of agents) {
      if (!out.has(a.id) && a.parentId !== null && out.has(a.parentId) && isLive(a)) {
        out.add(a.id)
        grew = true
      }
    }
  }
  return out
}

/** Живые агенты под id (дети, внуки…), без него самого. */
function liveDescendants(agents: readonly Agent[], id: string): Set<string> {
  const out = new Set<string>()
  for (let grew = true; grew; ) {
    grew = false
    for (const a of agents) {
      if (!out.has(a.id) && a.id !== id && a.parentId !== null && (a.parentId === id || out.has(a.parentId)) && isLive(a)) {
        out.add(a.id)
        grew = true
      }
    }
  }
  return out
}

/**
 * Агенты ids закончили (status/now — их итог): время конца, их недоигранные действия закрыты.
 * Уже закончивших не трогаем.
 */
function finishAgents(s: ClaudeState, ids: ReadonlySet<string>, end: Pick<Agent, 'status' | 'now'>, now: number): ClaudeState {
  if (ids.size === 0) return s
  const agents = s.agents.map((a) => (ids.has(a.id) && isLive(a) ? { ...a, ...end, endedAt: now } : a))
  const st = end.status === 'error' ? 'error' : 'done'
  const items = s.items.some((it) => it.type === 'action' && ids.has(it.agentId) && it.status === 'running')
    ? s.items.map((it): FeedClaudeItem => (it.type === 'action' && ids.has(it.agentId) && it.status === 'running' ? { ...it, status: st } : it))
    : s.items
  return { ...s, agents, items }
}

/**
 * Главный ждал фоновых (ход не идёт): подпись с новым их числом; дождался — «Думает» (CLI сейчас
 * начнёт ход с уведомлением; не начнёт — его закроет settleMain по таймауту).
 */
function mainAfterBackground(s: ClaudeState): ClaudeState {
  const main = s.agents.find((x) => x.id === MAIN)
  if (s.busy || main?.status !== 'running') return s
  const left = backgroundRunning(s)
  const label = left > 0 ? bgWaitLabel(left) : 'Думает'
  return main.now === label ? s : patchAgent(s, MAIN, { now: label })
}

/**
 * Главный «висит»: ход не идёт, фоновых нет, а он всё ещё «работает» — фоновые закончили, а свой
 * ход CLI так и не начал. sessionStore ждёт MAIN_IDLE_MS без событий и закрывает его settleMain.
 */
export function mainStale(s: ClaudeState): boolean {
  if (s.busy || s.pending > 0) return false
  const main = s.agents.find((a) => a.id === MAIN)
  return main?.status === 'running' && backgroundRunning(s) === 0
}

/** Сколько ждать событий CLI после конца фоновых агентов, прежде чем считать главного готовым. */
export const MAIN_IDLE_MS = 10_000

/** Главный «висит» (mainStale) — готов: фоновые закончили, ход CLI не начался. */
export function settleMain(s: ClaudeState, now: number): ClaudeState {
  if (!mainStale(s)) return s
  return patchAgent({ ...s, currentAgentId: null }, MAIN, { status: 'done', now: 'Готово', endedAt: now })
}

/** Живые фоновые агенты с id задачи CLI — им ⌃C шлёт stop_task. */
export function backgroundTasks(s: Pick<ClaudeState, 'agents'>): string[] {
  return s.agents.filter((a) => bgLive(a) && !!a.taskId).map((a) => a.taskId!)
}

/**
 * ⌃C, пока главный только ждёт фоновых агентов: они (и их субагенты) остановлены, главный —
 * «Остановлено» (уведомления «закончил» нет). Ход идёт — его прерывает interrupt, здесь не трогаем.
 */
export function stopBackground(s: ClaudeState, now: number): ClaudeState {
  if (s.busy) return s
  const ids = backgroundTree(s.agents)
  let next = finishAgents(s, ids, { status: 'done', now: 'Остановлено' }, now)
  const main = next.agents.find((a) => a.id === MAIN)
  if (main?.status === 'running') next = patchAgent({ ...next, currentAgentId: null }, MAIN, { status: 'done', now: 'Остановлено', endedAt: now })
  return next
}

/**
 * Ход главного агента закончен, а фоновые агенты ещё работают: их число (строка «Ждём N фоновых
 * агентов» в ленте); 0 — не ждём. Как в CLI: главный не «готов», пока не дождался фоновых.
 */
export function backgroundWait(s: ClaudeState): number {
  if (s.busy) return 0
  const main = s.agents.find((a) => a.id === MAIN)
  return main?.status === 'running' ? backgroundRunning(s) : 0
}

/** Подпись главного агента, пока он ждёт фоновых (как «ждёт фоновых агентов» в CLI). */
export const bgWaitLabel = (n: number) => `Ждёт фоновых агентов: ${n}`

/**
 * Событие главного агента, когда ход не идёт (pending 0): CLI сам начал ход — доставил главному
 * уведомление о завершении фонового агента (или фоновой команды). Ход считаем как обычный: занят,
 * его result закроет этот ход, а не чужой.
 */
function autoTurn(s: ClaudeState, aid: string, now: number): ClaudeState {
  if (aid !== MAIN || s.pending > 0 || s.busy) return s
  return patchAgent({ ...s, busy: true, pending: 1, currentAgentId: MAIN, suggestion: null }, MAIN, {
    status: 'running',
    startedAt: now,
    endedAt: null,
    now: 'Думает',
  })
}

function ensureAgent(s: ClaudeState, id: string, now: number): ClaudeState {
  if (s.agents.some((a) => a.id === id)) return s
  return { ...s, agents: [...s.agents, newAgent(id, MAIN, 'Агент', now)] }
}

export function userSent(s: ClaudeState, text: string, now: number, tokens?: Attachment[]): ClaudeState {
  // Точка правки этого сообщения: конец предыдущего хода; сессии ещё нет — первое сообщение.
  const at: EditPoint['at'] = s.chain ?? (s.sessionId === null ? 'fresh' : null)
  const next: ClaudeState = {
    ...s,
    edits: { ...s.edits, [s.items.length]: { at, epoch: s.epoch } },
    busy: true,
    pending: s.pending + 1,
    currentAgentId: MAIN,
    suggestion: null,
    items: [...s.items, tokens && tokens.length > 0 ? { type: 'user', text, tokens } : { type: 'user', text }],
  }
  return patchAgent(next, MAIN, { status: 'running', startedAt: now, endedAt: null, now: 'Думает' })
}

/**
 * «Отправить сейчас»: сообщение посреди хода — пузырь «Вы» сразу, ход тот же (pending не растёт,
 * точки правки нет). Пока CLI его не взял — steer (см. ClaudeState.steer).
 */
export function userSteered(s: ClaudeState, text: string, tokens?: Attachment[]): ClaudeState {
  const item: FeedClaudeItem = tokens && tokens.length > 0 ? { type: 'user', text, tokens, steer: true } : { type: 'user', text, steer: true }
  return { ...s, steer: (s.steer ?? 0) + 1, suggestion: null, items: [...s.items, item] }
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

/**
 * Сколько знаков результата инструмента храним: карточка показывает только первую непустую строку
 * (до 80 знаков), а целиком (файлы, вывод Bash) он лишь раздувал бы состояние и сохранение.
 */
export const RESULT_MAX = 200

/** Начало результата для карточки: без ведущих пустых строк, не длиннее RESULT_MAX. */
export function shortResultText(t: string): string {
  const s = t.trimStart()
  return s.length > RESULT_MAX ? s.slice(0, RESULT_MAX) : s
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

function diffOf(tool: string, i: Rec): FileDiff | undefined {
  const path = strOr(i.file_path)
  if (tool === 'Edit') return { before: strOr(i.old_string), after: strOr(i.new_string), path }
  if (tool === 'Write') return { before: '', after: strOr(i.content), path }
  if (tool === 'MultiEdit' && Array.isArray(i.edits)) {
    const parts = i.edits.filter(isRec).map((e) => ({ before: strOr(e.old_string), after: strOr(e.new_string) }))
    return {
      before: parts.map((e) => e.before).join('\n'),
      after: parts.map((e) => e.after).join('\n'),
      path,
      ...(parts.length > 1 ? { parts } : {}),
    }
  }
  return undefined
}

/**
 * Результат правки файла (`tool_use_result` события user): structuredPatch — куски с настоящими
 * номерами строк, originalFile — файл до правки (храним, только если небольшой), type create — новый файл.
 */
function withPatch(diff: FileDiff, r: unknown, single: boolean): FileDiff {
  if (!isRec(r)) return diff
  // tool_use_result — одно на событие: при нескольких tool_result в событии сверяем путь
  // (в одиночном — нет: /tmp и /private/tmp — один файл).
  const file = strOr(r.filePath)
  if (!single && file !== diff.path) return diff
  if (r.type === 'create') return { ...diff, created: true, ...(typeof r.content === 'string' ? { after: r.content } : {}) }
  const hunks = parseHunks(r.structuredPatch)
  if (!hunks || hunks.length === 0) return diff
  const original = typeof r.originalFile === 'string' && r.originalFile.length <= ORIGINAL_MAX ? r.originalFile : undefined
  const { parts: _parts, ...rest } = diff
  return { ...rest, hunks, ...(original !== undefined ? { original } : {}) }
}

function onToolUse(s: ClaudeState, aid: string, block: Rec, now: number): ClaudeState {
  const id = strOr(block.id)
  const tool = strOr(block.name)
  if (!id || !tool) return s
  const input = isRec(block.input) ? block.input : {}
  const label = nowLabel(tool, input)
  let next = s

  if (tool === 'TodoWrite' && Array.isArray(input.todos)) {
    next = upsertTodo(next, aid, id, parseTodos(input.todos))
  } else if (!next.items.some((it) => it.type === 'action' && it.toolUseId === id)) {
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
    const bg: Partial<Agent> = input.run_in_background === true ? { background: true } : {}
    if (next.agents.some((a) => a.id === id)) {
      next = patchAgent(next, id, { name, parentId: aid, ...bg })
    } else {
      next = { ...next, agents: [...next.agents, { ...newAgent(id, aid, name, now), ...bg }] }
    }
  }
  return next
}

function onAssistant(s: ClaudeState, ev: Rec, now: number): ClaudeState {
  const aid = typeof ev.parent_tool_use_id === 'string' ? ev.parent_tool_use_id : MAIN
  const msg = ev.message
  if (!isRec(msg)) return s
  let next = ensureAgent(autoTurn(s, aid, now), aid, now)
  next = { ...next, currentAgentId: aid }
  next = withModel(next, aid, strOr(msg.model))
  // Сообщения главного агента — цепочка сессии (у субагентов своя, по ней не перематываем).
  const uuid = strOr(ev.uuid)
  const session = strOr(ev.session_id) || next.sessionId
  if (aid === MAIN && uuid && !uuid.startsWith('-') && session) next = { ...next, chain: { session, uuid } }

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
  const single = msg.content.filter((b) => isRec(b) && b.type === 'tool_result').length === 1
  // Граница инструмента главного агента: отправленное посреди хода CLI вставляет сразу после неё.
  if (next.steer && ev.parent_tool_use_id == null && msg.content.some((b) => isRec(b) && b.type === 'tool_result')) next = { ...next, steer: 0 }
  for (const b of msg.content) {
    if (!isRec(b) || b.type !== 'tool_result') continue
    const id = strOr(b.tool_use_id)
    if (!id) continue
    const isError = b.is_error === true
    const status = isError ? 'error' : 'done'
    // Фоновый агент: tool_result — лишь «запущен» (служебный текст CLI не показываем), агент работает дальше.
    const launch = ev.tool_use_result ?? ev.toolUseResult
    const launched = !isError && (next.agents.find((a) => a.id === id)?.background === true || (single && isRec(launch) && launch.status === 'async_launched'))
    const result = launched ? 'Запущен в фоне' : shortResultText(resultText(b.content))
    let actionAgent: string | null = null
    next = {
      ...next,
      items: next.items.map((it) => {
        if (it.type === 'action' && it.toolUseId === id) {
          actionAgent = it.agentId
          const diff = it.diff && !isError ? withPatch(it.diff, ev.tool_use_result ?? ev.toolUseResult, single) : it.diff
          return { ...it, status, result, ...(diff ? { diff } : {}) } as FeedClaudeItem
        }
        // План (TodoWrite) — своя карточка, не действие: ответ тоже возвращает агента из «ждёт».
        if (it.type === 'todo' && it.toolUseId === id) actionAgent = it.agentId
        return it
      }),
    }
    if (launched && next.agents.some((a) => a.id === id)) {
      const model = isRec(launch) ? strOr(launch.resolvedModel) : ''
      // agentId запуска — id задачи CLI: по нему сверяем с background_tasks_changed, даже если
      // task_started не пришёл (или пришёл раньше агента).
      const tid = isRec(launch) && single ? strOr(launch.agentId) : ''
      next = withModel(patchAgent(next, id, (a) => ({ background: true, ...(tid && !a.taskId ? { taskId: tid } : {}) })), id, model)
    } else if (next.agents.some((a) => a.id === id)) {
      next = patchAgent(next, id, { status, endedAt: now, now: isError ? 'Ошибка' : 'Готово' })
    }
    if (actionAgent) {
      next = patchAgent(next, actionAgent, (a) => (a.status === 'waiting' ? { status: 'running' } : {}))
    }
  }
  return next
}

const squash = (t: string) => t.replace(/\s+/g, ' ').trim()

/** Текст итога (`result`) уже есть в ответах этого хода — второй раз его не показываем. */
function repeatsAnswer(items: readonly FeedClaudeItem[], result: string): boolean {
  const r = squash(result)
  if (!r) return false
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (it.type === 'user' && !it.steer) break
    if (it.type === 'assistant' && squash(it.text).includes(r)) return true
  }
  return false
}

function onResult(prev: ClaudeState, ev: Rec, now: number, interrupted = false): ClaudeState {
  // Ход закончен — его вопросы и запросы разрешений больше не ждут ответа.
  const s = cancelPrompts(prev)
  // Прерванный пользователем ход CLI закрывает result с is_error — это не ошибка, а «Прервано».
  const stopped = interrupted
  const isError = ev.is_error === true && !stopped
  const doneNow = stopped ? 'Остановлено' : isError ? 'Ошибка' : 'Готово'
  const prevProc = s.costProc ?? 0
  const procTotal = typeof ev.total_cost_usd === 'number' && ev.total_cost_usd >= 0 ? ev.total_cost_usd : prevProc
  // Ход стоит разницу нарастающих итогов процесса; итог сессии — с учётом прежних процессов.
  // Итог процесса не растёт, а стал меньше — это уже другой процесс: прежний итог уходит в базу.
  // Итог до процесса неизвестен — этот result его и задаёт, цена хода неизвестна.
  const unknown = s.costUnknown === true
  const reset = !unknown && procTotal < prevProc
  const costBase = unknown ? 0 : (s.costBase ?? 0) + (reset ? prevProc : 0)
  const turnCost = unknown ? undefined : reset ? procTotal : procTotal - prevProc
  const cost = costBase + procTotal
  const sessionId = strOr(ev.session_id) || s.sessionId
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
  const result = strOr(ev.result)
  const durationMs = num(ev.duration_ms)
  const price = turnCost === undefined ? {} : { costUsd: turnCost }
  // Время и цена хода — в подвале последнего ответа главного агента этого хода.
  // Граница хода — итог предыдущего или сообщение «Вы», с которого ход начался (pending-е с конца:
  // более поздние — следующие ходы в очереди claude). Так подвал не попадает на ответ из истории
  // `/resume` (в ней нет итогов) или прерванного хода без result.
  let users = 0
  let shown = false
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (it.type === 'summary') break
    if (it.type === 'user' && !it.steer && ++users >= Math.max(1, s.pending)) break
    // Ответ со временем хода — из уже законченного хода (очередь: U1, U2, A1), не этого.
    if (it.type === 'assistant' && it.turn) break
    if (it.type === 'assistant' && it.agentId === MAIN) {
      items[i] = { ...it, turn: { durationMs, ...price } }
      shown = true
      break
    }
  }
  // Отдельная карточка итога — только когда она что-то добавляет: ошибка, итог, отличный от ответа,
  // или ход без ответа (время и цену негде показать). «✓ Готово» после ответа не нужен.
  const text = repeatsAnswer(items, result) ? '' : result
  if (stopped) items.push({ type: 'summary', text, durationMs, ...price, isError: false, stopped: true })
  else if (isError || text || !shown) items.push({ type: 'summary', text, durationMs, ...price, isError })
  // Ход закончен: его незавершённые действия и субагенты больше не идут. Кроме фоновых: они
  // работают дальше (и их действия тоже), до своего task_notification.
  const bg = backgroundTree(s.agents)
  const closed: FeedClaudeItem[] = items.map((it) =>
    it.type === 'action' && it.status === 'running' && !bg.has(it.agentId) ? { ...it, status: isError ? 'error' : 'done' } : it,
  )
  // Отправленное посреди хода CLI так и не взял (после него инструментов не было) — оно станет
  // следующим ходом, CLI начнёт его сам: занятость остаётся, очередь приложения ждёт его конца.
  // После ⌃C не ждём: если CLI всё же начнёт его ход, это подхватит autoTurn.
  const pending = Math.max(0, s.pending - 1) || (s.steer && !interrupted ? 1 : 0)
  let next: ClaudeState = {
    ...s,
    items: closed,
    pending,
    ...(s.steer ? { steer: 0 } : {}),
    busy: pending > 0,
    costUsd: cost,
    costBase,
    costProc: procTotal,
    costUnknown: false,
    ...(sessionId ? { costOf: { ...s.costOf, [sessionId]: procTotal } } : {}),
    contextMax,
    // Подсказка прежнего хода устарела; новая придёт после этого result.
    suggestion: null,
    turnEndAt: now,
    sessionId,
    currentAgentId: pending > 0 ? MAIN : null,
    agents: s.agents.map((a) =>
      a.id !== MAIN && !bg.has(a.id) && (a.status === 'running' || a.status === 'waiting')
        ? { ...a, status: isError ? 'error' : 'done', endedAt: now, now: doneNow }
        : a,
    ),
  }
  // В очереди ещё сообщение — главный агент продолжает (следующий ход), «закончил» не наступает.
  if (pending > 0) return patchAgent(next, MAIN, { status: 'running', now: 'Думает' })
  // Фоновые агенты ещё работают — главный их ждёт (CLI сам начнёт ход, когда они закончат):
  // не «готово», уведомление «закончил» — после них. Ошибку хода не скрываем.
  if (bg.size > 0 && !isError) return patchAgent(next, MAIN, { status: 'running', endedAt: null, now: bgWaitLabel(backgroundRunning(next)) })
  next = patchAgent(next, MAIN, { status: isError ? 'error' : 'done', endedAt: now, now: doneNow })
  return next
}

/** Агент задачи CLI: по tool_use_id (Agent/Task), иначе по запомненному task_id. */
function taskAgent(s: ClaudeState, ev: Rec): Agent | undefined {
  const tu = strOr(ev.tool_use_id)
  const tid = strOr(ev.task_id)
  return s.agents.find((a) => a.id !== MAIN && ((tu !== '' && a.id === tu) || (tid !== '' && a.taskId === tid)))
}

/** Статус task_notification → статус и подпись агента. */
function taskEnd(status: string): Pick<Agent, 'status' | 'now'> {
  if (status === 'failed') return { status: 'error', now: 'Ошибка' }
  // Остановлен (TaskStop, ⌃C, выход): не «закончил» — уведомления нет (см. notify.agentEvents).
  if (status === 'stopped' || status === 'killed') return { status: 'done', now: 'Остановлено' }
  return { status: 'done', now: 'Готово' }
}

/**
 * `background_tasks_changed`: полный список фоновых задач CLI сейчас. Фоновый агент, которого в
 * нём нет, закончил — даже если его task_notification потерялся (итог неизвестен: «Готово»; об
 * ошибке CLI сообщил бы уведомлением). Агенты без id задачи не сверяем: список может прийти
 * раньше их task_started.
 */
function onBackgroundTasks(s: ClaudeState, ev: Rec, now: number): ClaudeState {
  if (!Array.isArray(ev.tasks)) return s
  const ids = new Set(ev.tasks.map((t) => (isRec(t) ? strOr(t.task_id) : '')).filter(Boolean))
  const gone = s.agents.filter((a) => bgLive(a) && !!a.taskId && !ids.has(a.taskId))
  if (gone.length === 0) return s
  let next = finishAgents(s, new Set(gone.map((a) => a.id)), { status: 'done', now: 'Готово' }, now)
  for (const a of gone) next = finishAgents(next, liveDescendants(next.agents, a.id), { status: 'done', now: 'Остановлено' }, now)
  return mainAfterBackground(next)
}

/**
 * События задач CLI (`system` task_started / task_progress / task_updated / task_notification).
 * Задачи без агента в панели (фоновые команды Bash, команды внутри субагента) пропускаем.
 */
function onTask(s: ClaudeState, ev: Rec, now: number): ClaudeState {
  const a = taskAgent(s, ev)
  if (!a) return s
  const tid = strOr(ev.task_id)
  switch (ev.subtype) {
    case 'task_started':
      return patchAgent(s, a.id, {
        ...(tid ? { taskId: tid } : {}),
        ...(ev.is_backgrounded === true ? { background: true } : {}),
      })
    case 'task_updated': {
      // Агент ушёл в фон посреди работы (patch.is_backgrounded).
      const p = isRec(ev.patch) ? ev.patch : {}
      return p.is_backgrounded === true ? patchAgent(s, a.id, { background: true }) : s
    }
    case 'task_progress': {
      if (a.status !== 'running' && a.status !== 'waiting') return s
      const u = isRec(ev.usage) ? ev.usage : {}
      const patch: Partial<Agent> = {}
      if (num(u.total_tokens) > 0) patch.tokens = num(u.total_tokens)
      if (num(u.tool_uses) > 0) patch.toolUses = num(u.tool_uses)
      // Своё «сейчас» агент берёт из своих tool_use; пока их не видно — по последнему инструменту.
      const tool = strOr(ev.last_tool_name)
      if (!a.now && tool) patch.now = nowLabel(tool, {})
      return Object.keys(patch).length > 0 ? patchAgent(s, a.id, patch) : s
    }
    case 'task_notification': {
      if (a.status !== 'running' && a.status !== 'waiting') return s
      const u = isRec(ev.usage) ? ev.usage : {}
      const end = taskEnd(strOr(ev.status))
      let next = patchAgent(s, a.id, {
        ...(num(u.total_tokens) > 0 ? { tokens: num(u.total_tokens) } : {}),
        ...(num(u.tool_uses) > 0 ? { toolUses: num(u.tool_uses) } : {}),
      })
      // Он, его субагенты и их недоигранные действия больше не идут (субагенты — «Остановлено»:
      // их итог неизвестен, «закончил» о них не шлём).
      next = finishAgents(next, new Set([a.id]), end, now)
      next = finishAgents(next, liveDescendants(next.agents, a.id), { status: 'done', now: 'Остановлено' }, now)
      return mainAfterBackground(next)
    }
    default:
      return s
  }
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

/**
 * Запросы агентов agentIds закрыты (ответ, решение, отмена): агент, который ждал только их, снова
 * работает — панель агентов, точка вкладки и индикатор «думает» не застревают в «ждёт» до tool_result.
 * Агент, у которого ещё есть ждущий запрос, остаётся ждать.
 */
function resumeWaiting(s: ClaudeState, agentIds: ReadonlySet<string>): ClaudeState {
  if (agentIds.size === 0) return s
  const still = new Set(s.items.filter(isPending).map((it) => it.agentId))
  if (!s.agents.some((a) => agentIds.has(a.id) && a.status === 'waiting' && a.startedAt > 0 && !still.has(a.id))) return s
  return {
    ...s,
    agents: s.agents.map((a) =>
      agentIds.has(a.id) && a.status === 'waiting' && a.startedAt > 0 && !still.has(a.id) ? { ...a, status: 'running', now: 'Думает' } : a,
    ),
  }
}

/** Ждущие запросы отменены (все или только requestId): ответа на них больше не ждут. */
export function cancelPrompts(s: ClaudeState, requestId?: string, reason: CancelReason = 'stop'): ClaudeState {
  if (!s.items.some((it) => isPending(it) && (requestId === undefined || it.requestId === requestId))) return s
  const agents = new Set<string>()
  const next = {
    ...s,
    items: s.items.map((it) => {
      if (!isPending(it) || (requestId !== undefined && it.requestId !== requestId)) return it
      agents.add(it.agentId)
      return { ...it, cancelled: reason }
    }),
  }
  return resumeWaiting(next, agents)
}

/** Решение по запросу разрешения. */
export function decidePermission(s: ClaudeState, requestId: string, decision: PermissionDecision): ClaudeState {
  const i = s.items.findIndex((it) => it.type === 'permission' && it.requestId === requestId)
  const it = s.items[i]
  if (!it || it.type !== 'permission' || !isPending(it)) return s
  const items = s.items.slice()
  items[i] = { ...it, done: true, decision }
  return resumeWaiting({ ...s, items }, new Set([it.agentId]))
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
  const next = patchQuestion(s, requestId, (q) =>
    q.questions.every((_, i) => (q.answers[i] ?? '') !== '') ? { ...q, done: true } : null,
  )
  if (next === s) return s
  const q = next.items.find((it) => it.type === 'question' && it.requestId === requestId)
  return q?.type === 'question' ? resumeWaiting(next, new Set([q.agentId])) : next
}

/** Первый ждущий вопрос (не разрешение). */
export function pendingQuestion(s: ClaudeState): Extract<FeedClaudeItem, { type: 'question' }> | null {
  const p = pendingPrompt(s)
  return p?.type === 'question' ? p : null
}

/** Инструменты, меняющие файлы: при правке сообщения их изменения не откатываются. */
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

function touchesFiles(items: readonly FeedClaudeItem[]): boolean {
  return items.some((it) => (it.type === 'action' && FILE_TOOLS.has(it.tool)) || (it.type === 'replaced' && touchesFiles(it.items)))
}

/** Сообщения «Вы» текущей сессии (индексы в items), по порядку. */
function userIndices(s: ClaudeState): number[] {
  const out: number[] = []
  s.items.forEach((it, i) => {
    if (it.type === 'user' && s.edits[i]?.epoch === s.epoch) out.push(i)
  })
  return out
}

/** Сообщение index можно изменить: «Вы» текущей сессии с известной точкой перемотки. */
export function canEdit(s: ClaudeState, index: number): boolean {
  const e = s.edits[index]
  return s.items[index]?.type === 'user' && !!e && e.epoch === s.epoch && e.at !== null
}

/** Последнее отправленное сообщение, если его можно изменить; иначе -1. */
export function lastEditable(s: ClaudeState): number {
  const us = userIndices(s)
  const last = us[us.length - 1]
  return last !== undefined && canEdit(s, last) ? last : -1
}

export interface EditInfo {
  /** Номер сообщения среди сообщений «Вы» сессии и их число. */
  n: number
  total: number
  /** Сообщений «Вы» после него (уйдут в историю). */
  after: number
  /** Claude ещё отвечает. */
  busy: boolean
  /** После него были правки файлов (Edit/Write…): они не откатываются. */
  files: boolean
}

/** Что сделает правка сообщения index (для подсказки над строкой ввода); null — нельзя. */
export function editInfo(s: ClaudeState, index: number): EditInfo | null {
  if (!canEdit(s, index)) return null
  const us = userIndices(s)
  const n = us.indexOf(index) + 1
  return { n, total: us.length, after: us.length - n, busy: s.busy, files: touchesFiles(s.items.slice(index + 1)) }
}

/**
 * Claude думает: ход идёт, а в ленте нет ничего живого — ни печатающегося ответа, ни идущего
 * инструмента (у него свой спиннер), и он не ждёт ответа на вопрос или разрешение.
 * Возвращает начало хода (для «· 12 с») или null — индикатор не нужен.
 */
export function thinkingSince(s: ClaudeState): number | null {
  if (!s.busy) return null
  const main = s.agents.find((a) => a.id === MAIN)
  if (!main || main.status !== 'running') return null
  const last = s.items[s.items.length - 1]
  if (last?.type === 'assistant' && last.streaming) return null
  if (s.items.some((it) => it.type === 'action' && it.status === 'running')) return null
  return main.startedAt
}

/** Агент для подписи карточки (по agentId элемента). */
export function agentOf(agents: readonly Agent[] | undefined, x: FeedClaudeItem): Agent | undefined {
  return x.type === 'assistant' || x.type === 'action' || x.type === 'question' ? agents?.find((a) => a.id === x.agentId) : undefined
}

/** «1 сообщение», «3 сообщения», «5 сообщений». */
export function messagesLabel(n: number): string {
  const d = n % 10
  const dd = n % 100
  const w = d === 1 && dd !== 11 ? 'сообщение' : d >= 2 && d <= 4 && (dd < 12 || dd > 14) ? 'сообщения' : 'сообщений'
  return `${n} ${w}`
}

/**
 * Правка сообщения index: оно и всё после него — «Прежний вариант» на его месте (индексы
 * остальных не сдвигаются), недоигранное в нём закрыто.
 */
export function replaceFrom(s: ClaudeState, index: number): ClaudeState {
  if (index < 0 || index >= s.items.length) return s
  const old = closeUnfinished(s.items.slice(index))
  const count = old.filter((it) => it.type === 'user').length
  const items = s.items.slice(0, index)
  items.push({ type: 'replaced', items: old, count })
  for (let i = index + 1; i < s.items.length; i++) items.push({ type: 'gone' })
  // План, начатый до правленого сообщения, мог обновляться после него (отброшенная ветка):
  // больше не обновляется — план ответвления начнёт новую карточку.
  return freezeTodos({ ...s, items }, index)
}

/** interrupted — ход прерван пользователем: его result — «Прервано», а не ошибка. */
export function reduceClaude(s: ClaudeState, line: string | object, now: number, interrupted = false): ClaudeState {
  const ev = parse(line)
  if (!ev) return s
  try {
    switch (ev.type) {
      case 'system':
        if (ev.subtype === 'init') {
          const model = strOr(ev.model) || s.model
          let next: ClaudeState = { ...s, sessionId: strOr(ev.session_id) || s.sessionId, model }
          if (model) next = patchAgent(next, MAIN, { model })
          // Главный дождался фоновых, CLI начинает свой ход (init — в начале каждого хода): ход идёт
          // уже сейчас, а не с первым токеном ответа (до него может пройти больше MAIN_IDLE_MS).
          if (mainStale(next)) next = autoTurn(next, MAIN, now)
          return next
        }
        if (ev.subtype === 'background_tasks_changed') return onBackgroundTasks(s, ev, now)
        if (typeof ev.subtype === 'string' && ev.subtype.startsWith('task_')) return onTask(s, ev, now)
        return s
      case 'stream_event': {
        const e = ev.event
        if (!isRec(e)) return s
        const aid = typeof ev.parent_tool_use_id === 'string' ? ev.parent_tool_use_id : MAIN
        if (e.type === 'message_start' && isRec(e.message)) {
          return withModel(ensureAgent(autoTurn(s, aid, now), aid, now), aid, strOr(e.message.model))
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
        return onResult(s, ev, now, interrupted)
      case 'control_response':
        return onControl(s, ev)
      case 'control_request':
        return onControlRequest(s, ev, now)
      case 'prompt_suggestion':
        return onSuggestion(s, ev)
      case 'control_cancel_request':
        return typeof ev.request_id === 'string' ? cancelPrompts(s, ev.request_id) : s
      default:
        return s
    }
  } catch {
    return s
  }
}
