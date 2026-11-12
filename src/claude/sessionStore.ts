// Claude-сессии панелей: процесс `claude` на панель, его состояние (ClaudeState) — в сторе по paneId,
// чтобы его читали лента панели, панель агентов и статус-бар.
import { Channel, invoke } from '@tauri-apps/api/core'
import { create } from 'zustand'
import { cancelPrompts, decidePermission, finishQuestion, gotoStep, initialClaude, questionSteps, recordAnswer, reduceClaude, userSent, type ClaudeState } from './reducer'
import { allowResponse, alwaysResponse, answerResponse, denyResponse, parsePermissionRequest } from './questions'
import type { PermissionDecision } from './reducer'
import { GET_SETTINGS, effortRequest, modelNote, persistedModel, setModelRequest, type ModelChoice } from './models'

export type { ModelChoice }

export interface ClaudeExit {
  code: number | null
  stderr: string
}

export interface PaneClaude {
  state: ClaudeState
  /** id процесса на стороне Rust; null — процесс не запущен (ещё или уже). */
  procId: string | null
  /**
   * Каталог сессии: сессии Claude привязаны к каталогу проекта. ⌘↵ из другого каталога панели
   * начинает новую сессию там (старый процесс останавливается, без --resume).
   */
  cwd: string | null
  /** Модель и усилие, выбранные в `/model`: передаются процессу при (пере)запуске. */
  model: string | null
  effort: string | null
}

interface SessionsStore {
  sessions: Record<string, PaneClaude>
}

export const useClaudeSessions = create<SessionsStore>(() => ({ sessions: {} }))

/** Сколько последних строк stderr показываем в карточке ошибки. */
const STDERR_LINES = 12

/** Запуск процесса панели: пока он идёт, следующие сообщения ждут его. */
interface Proc {
  ready: Promise<string | null>
  id: string | null
  /** Пользователь прервал ход (⌃C): выход процесса после этого — не ошибка; неотправленное не шлём. */
  interrupted: boolean
  /** Отправки по очереди: claude_send — async-команда, параллельные вызовы могли бы переставиться. */
  chain: Promise<void>
}
const procs = new Map<string, Proc>()

function get(paneId: string): PaneClaude {
  return useClaudeSessions.getState().sessions[paneId] ?? { state: initialClaude(), procId: null, cwd: null, model: null, effort: null }
}

function patch(paneId: string, f: (p: PaneClaude) => PaneClaude): void {
  useClaudeSessions.setState((st) => ({ sessions: { ...st.sessions, [paneId]: f(get(paneId)) } }))
}

const patchState = (paneId: string, f: (s: ClaudeState) => ClaudeState) =>
  patch(paneId, (p) => ({ ...p, state: f(p.state) }))

/** Ход оборвался ошибкой: карточка ошибки, сессия не занята, главный агент — «Ошибка». */
function failed(s: ClaudeState, text: string, now: number): ClaudeState {
  return {
    ...s,
    busy: false,
    pending: 0,
    currentAgentId: null,
    items: [...s.items, { type: 'error', text }],
    agents: s.agents.map((a) =>
      a.id === 'main' && (a.status === 'running' || a.status === 'waiting') && a.startedAt > 0
        ? { ...a, status: 'error', now: 'Ошибка', endedAt: now }
        : a,
    ),
  }
}

function stopped(s: ClaudeState, now: number): ClaudeState {
  if (!s.busy) return s
  return {
    ...s,
    busy: false,
    pending: 0,
    currentAgentId: null,
    agents: s.agents.map((a) =>
      a.status === 'running' || (a.status === 'waiting' && a.startedAt > 0) ? { ...a, status: 'done', now: 'Остановлено', endedAt: now } : a,
    ),
  }
}

export function exitMessage(e: ClaudeExit): string {
  const tail = e.stderr.trimEnd().split('\n').slice(-STDERR_LINES).join('\n').trim()
  const head = e.code === null ? 'Claude Code завершился аварийно' : `Claude Code завершился с кодом ${e.code}`
  return tail ? `${head}:\n${tail}` : head
}

/** Процесс claude вышел сам с кодом 0 посреди хода (без ⌃C). */
export const EXITED_MID_TURN = 'Claude завершился, не закончив ответ'
/** ⌘↵ раньше, чем панель узнала свой каталог (OSC 7). */
export const NO_CWD = 'Каталог панели ещё неизвестен — повторите через секунду'

function start(paneId: string): Proc {
  const proc: Proc = { ready: Promise.resolve(null), id: null, interrupted: false, chain: Promise.resolve() }
  const alive = () => procs.get(paneId) === proc
  const prev = get(paneId)
  const resume = prev.state.sessionId
  const { cwd, model, effort } = prev
  let gotLine = false
  const onLine = new Channel<string>((line) => {
    gotLine = true
    if (!alive()) return
    if (line.includes('"control_response"')) settleControl(line)
    if (line.includes('"control_request"')) {
      // Вопросы и разрешения ждут пользователя (блок над строкой ввода); ввод не объект — запрещаем сразу.
      const r = parsePermissionRequest(line)
      if (r?.kind === 'deny' && proc.id) {
        invoke('claude_respond', { id: proc.id, requestId: r.requestId, response: denyResponse() }).catch(() => {})
      }
    }
    patchState(paneId, (s) => reduceClaude(s, line, Date.now()))
  })
  const onExit = new Channel<ClaudeExit>((e) => {
    // Ответов на управляющие запросы этого процесса уже не будет.
    if (proc.id) rejectControls(proc.id)
    if (!alive()) return
    procs.delete(paneId)
    const ok = e.code === 0 || proc.interrupted
    patch(paneId, (p) => {
      const now = Date.now()
      let state = proc.interrupted
        ? stopped(p.state, now)
        : e.code === 0
          ? p.state.busy
            ? failed(p.state, EXITED_MID_TURN, now)
            : p.state
          : failed(p.state, exitMessage(e), now)
      // --resume упал, не сказав ни строки (сессии нет или она из другого каталога) — дальше начинаем
      // новую сессию, а не повторяем тот же resume на каждый ⌘↵.
      if (!ok && resume !== null && !gotLine) state = { ...state, sessionId: null }
      // Вопрос без процесса не ответить: отменяем (блок над строкой ввода исчезает).
      state = cancelPrompts(state, undefined, 'exit')
      return { ...p, procId: null, state }
    })
  })
  proc.ready = invoke<string>('claude_start', { cwd, resume, model, effort, onLine, onExit })
    .then((id) => {
      if (!alive()) {
        // Панель закрыли, пока процесс запускался.
        invoke('claude_stop', { id }).catch(() => {})
        return null
      }
      proc.id = id
      patch(paneId, (p) => ({ ...p, procId: id }))
      // Текущие модель и усилие — сразу в статус-бар и карточку выбора модели (запрос бесплатный).
      control(id, GET_SETTINGS).catch(() => {})
      return id
    })
    .catch((err: unknown) => {
      if (alive()) {
        procs.delete(paneId)
        patch(paneId, (p) => ({ ...p, procId: null, state: failed(p.state, String(err), Date.now()) }))
      }
      return null
    })
  procs.set(paneId, proc)
  return proc
}

/** Ожидающие ответа управляющие запросы: request_id → обработчики. */
const pendingControls = new Map<
  string,
  { procId: string; resolve(r: Record<string, unknown>): void; reject(e: Error): void }
>()

/** Процесс завершился: его управляющие запросы — сразу ошибкой (не ждём таймаута). */
function rejectControls(procId: string): void {
  for (const [rid, p] of pendingControls) {
    if (p.procId !== procId) continue
    pendingControls.delete(rid)
    p.reject(new Error('Claude завершился'))
  }
}
let controlSeq = 0
/** Сколько ждать control_response. */
export const CONTROL_TIMEOUT_MS = 10000

function settleControl(line: string): void {
  let ev: unknown
  try {
    ev = JSON.parse(line)
  } catch {
    return
  }
  const r = (ev as { response?: Record<string, unknown> } | null)?.response
  if (!r || typeof r.request_id !== 'string') return
  const p = pendingControls.get(r.request_id)
  if (!p) return
  pendingControls.delete(r.request_id)
  if (r.subtype === 'success') p.resolve((r.response as Record<string, unknown> | undefined) ?? {})
  else p.reject(new Error(typeof r.error === 'string' ? r.error : 'управляющий запрос не выполнен'))
}

/** Управляющий запрос процессу `id`; ответ — тело `control_response`. */
function control(id: string, request: object): Promise<Record<string, unknown>> {
  const requestId = `kv-${++controlSeq}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingControls.delete(requestId)
      reject(new Error('Claude не ответил на управляющий запрос'))
    }, CONTROL_TIMEOUT_MS)
    pendingControls.set(requestId, {
      procId: id,
      resolve: (r) => {
        clearTimeout(timer)
        resolve(r)
      },
      reject: (e) => {
        clearTimeout(timer)
        reject(e)
      },
    })
    invoke('claude_control', { id, requestId, request }).catch((e: unknown) => {
      pendingControls.delete(requestId)
      clearTimeout(timer)
      reject(e instanceof Error ? e : new Error(String(e)))
    })
  })
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * `/model`: модель (и усилие) живой сессии меняются управляющими запросами — без перезапуска;
 * при следующем запуске процесса они же передаются флагами. Процесса нет — он запускается
 * (с `--resume`, если сессия была). В ленте — заметка, статус-бар обновляется ответом set_model.
 */
export async function chooseModel(paneId: string, paneCwd: string | undefined, c: ModelChoice): Promise<void> {
  const cwd = switchCwd(paneId, paneCwd)
  if (cwd === null) {
    patchState(paneId, (s) => failed(s, NO_CWD, Date.now()))
    return
  }
  const proc = procs.get(paneId) ?? start(paneId)
  const id = await proc.ready
  if (id === null || procs.get(paneId) !== proc) return
  // Тот же id, что пишется в настройки (с суффиксом контекста `[1m]` того же семейства).
  const target = persistedModel(c.alias, get(paneId).state.defaultModel) ?? 'default'
  try {
    const r = await control(id, setModelRequest(target))
    // Модель панели (для перезапуска) запоминаем, только когда CLI её принял.
    patch(paneId, (p) => ({ ...p, model: target }))
    if (c.effort) {
      await control(id, effortRequest(c.effort))
      patch(paneId, (p) => ({ ...p, effort: c.effort }))
    }
    const modelId = typeof r.model === 'string' && r.model ? r.model : (get(paneId).state.model ?? c.alias)
    // Применённое усилие могло смениться вместе с моделью (у моделей свои настройки).
    const applied = await control(id, GET_SETTINGS).catch(() => null)
    const effort = (applied && (applied.applied as { effort?: string } | undefined)?.effort) || c.effort
    patchState(paneId, (s) => ({ ...s, items: [...s.items, { type: 'note', text: modelNote(modelId, effort ?? null) }] }))
    if (c.persist) {
      // Default — убрать модель из настроек: Claude Code возьмёт свою по умолчанию.
      const model = target === 'default' ? null : target
      await invoke('claude_save_defaults', { model, modelId, effort: c.effort }).catch((e: unknown) =>
        addError(paneId, `Модель не сохранена по умолчанию: ${errText(e)}`),
      )
    }
  } catch (e) {
    addError(paneId, `Не удалось сменить модель: ${errText(e)}`)
  }
}

const addError = (paneId: string, text: string) =>
  patchState(paneId, (s) => ({ ...s, items: [...s.items, { type: 'error', text }] }))

/** Остановить процесс панели (его события дальше игнорируются). */
function dropProc(paneId: string): void {
  const proc = procs.get(paneId)
  procs.delete(paneId)
  if (proc?.id) invoke('claude_stop', { id: proc.id }).catch(() => {})
}

/**
 * Каталог сессии для вопроса из панели в paneCwd: если панель перешла в другой каталог —
 * старый процесс останавливается и дальше будет новая сессия там. null — каталог неизвестен.
 */
function switchCwd(paneId: string, paneCwd: string | undefined): string | null {
  const cur = get(paneId)
  const cwd = paneCwd ?? cur.cwd
  if (cwd === null) return null
  if (cur.cwd !== null && cwd !== cur.cwd) {
    dropProc(paneId)
    patchState(paneId, (s) => ({ ...stopped(s, Date.now()), sessionId: null, contextUsed: 0 }))
  }
  if (cur.cwd !== cwd) patch(paneId, (p) => ({ ...p, cwd }))
  return cwd
}

/**
 * `claude` в строке ввода: режим Claude панели. Процесс запускается сразу (если ещё не идёт),
 * в ленте — строка с каталогом и подсказкой; вопросы дальше — через askClaude.
 */
export function enterClaude(paneId: string, paneCwd: string | undefined): boolean {
  const cwd = switchCwd(paneId, paneCwd)
  if (cwd === null) {
    patchState(paneId, (s) => failed(s, NO_CWD, Date.now()))
    return false
  }
  patchState(paneId, (s) => ({ ...s, items: [...s.items, { type: 'session', cwd, mode: true }] }))
  if (!procs.has(paneId)) start(paneId)
  return true
}

/** Каталог для сессии панели известен (из панели или прежней сессии): askClaude не упадёт на NO_CWD. */
export function claudeCwdKnown(paneId: string, paneCwd: string | undefined): boolean {
  return (paneCwd ?? get(paneId).cwd) !== null
}

/**
 * ⌘↵: вопрос в Claude-сессию панели. Карточка «Вы» — сразу; процесс запускается при первом
 * сообщении (и заново после выхода — с `--resume`, если id сессии известен). Если панель
 * с тех пор перешла в другой каталог — новая сессия там; начало новой сессии отмечается в ленте.
 */
export async function askClaude(paneId: string, paneCwd: string | undefined, text: string): Promise<void> {
  const cwd = switchCwd(paneId, paneCwd)
  if (cwd === null) {
    patchState(paneId, (s) => failed(userSent(s, text, Date.now()), NO_CWD, Date.now()))
    return
  }
  // Новая сессия (не продолжение): в ленте — строка с её каталогом.
  if (!procs.has(paneId) && get(paneId).state.sessionId === null) {
    patchState(paneId, (s) => ({ ...s, items: [...s.items, { type: 'session', cwd }] }))
  }
  patchState(paneId, (s) => userSent(s, text, Date.now()))
  const proc = procs.get(paneId) ?? start(paneId)
  proc.interrupted = false
  proc.chain = proc.chain.then(async () => {
    const id = await proc.ready
    if (id === null || procs.get(paneId) !== proc) return
    // ⌃C пришёл, пока процесс запускался: вопрос не отправляем.
    if (proc.interrupted) {
      patchState(paneId, (s) => stopped(s, Date.now()))
      return
    }
    try {
      await invoke('claude_send', { id, text })
    } catch (err) {
      patchState(paneId, (s) => failed(s, String(err), Date.now()))
    }
  })
  return proc.chain
}

const questionOf = (paneId: string, requestId: string) => {
  const q = get(paneId).state.items.find((it) => it.type === 'question' && it.requestId === requestId)
  return q?.type === 'question' ? q : null
}

/**
 * Ответ на вопрос index (вариант, несколько — через запятую, или свой текст). Один вопрос — ответ
 * уходит сразу; у нескольких — переход к следующему, отправка — submitQuestion.
 */
export async function answerQuestion(paneId: string, requestId: string, index: number, answer: string): Promise<void> {
  patchState(paneId, (s) => recordAnswer(s, requestId, index, answer))
  const q = questionOf(paneId, requestId)
  if (q && questionSteps(q) === 1) await submitQuestion(paneId, requestId)
}

/** Вкладка (шаг) вопроса: ←/→. */
export function questionStep(paneId: string, requestId: string, step: number): void {
  patchState(paneId, (s) => gotoStep(s, requestId, step))
}

/** «Отправить ответы»: все ответы — процессу одним control_response, агент продолжает. */
export async function submitQuestion(paneId: string, requestId: string): Promise<void> {
  patchState(paneId, (s) => finishQuestion(s, requestId))
  const q = questionOf(paneId, requestId)
  if (!q || !q.done) return
  const id = procs.get(paneId)?.id
  if (!id) {
    addError(paneId, 'Claude не запущен — ответ не отправлен')
    return
  }
  try {
    await invoke('claude_respond', { id, requestId, response: answerResponse(q.input, q.answers) })
  } catch (e) {
    addError(paneId, `Ответ не отправлен: ${errText(e)}`)
  }
}

/** Решение по запросу разрешения: разрешить, разрешить всегда (правила CLI), запретить. */
export async function answerPermission(paneId: string, requestId: string, decision: PermissionDecision): Promise<void> {
  const it = get(paneId).state.items.find((x) => x.type === 'permission' && x.requestId === requestId)
  if (!it || it.type !== 'permission' || it.done || it.cancelled) return
  patchState(paneId, (s) => decidePermission(s, requestId, decision))
  const response =
    decision === 'deny'
      ? denyResponse()
      : decision === 'always' && it.suggestions
        ? alwaysResponse(it.input, it.suggestions)
        : allowResponse(it.input)
  const id = procs.get(paneId)?.id
  if (!id) return addError(paneId, 'Claude не запущен — ответ не отправлен')
  try {
    await invoke('claude_respond', { id, requestId, response })
  } catch (e) {
    addError(paneId, `Ответ не отправлен: ${errText(e)}`)
  }
}

/** ⌃C: прервать текущий ход Claude. false — Claude не занят, прерывать нечего. */
export function interruptClaude(paneId: string): boolean {
  const proc = procs.get(paneId)
  if (!get(paneId).state.busy || !proc) return false
  proc.interrupted = true
  // Прерванный ход — его вопросы и разрешения больше не ждут.
  patchState(paneId, (s) => cancelPrompts(s))
  // Процесс ещё запускается — отметки достаточно: askClaude не отправит вопрос.
  if (proc.id) invoke('claude_interrupt', { id: proc.id }).catch(() => {})
  return true
}

/** Панель закрыта: процесс остановить, состояние забыть. */
export function stopClaude(paneId: string): void {
  dropProc(paneId)
  useClaudeSessions.setState((st) => {
    if (!(paneId in st.sessions)) return st
    const sessions = { ...st.sessions }
    delete sessions[paneId]
    return { sessions }
  })
}
