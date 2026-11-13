// Claude-сессии панелей: процесс `claude` на панель, его состояние (ClaudeState) — в сторе по paneId,
// чтобы его читали лента панели, панель агентов и статус-бар.
import { Channel, invoke } from '@tauri-apps/api/core'
import { create } from 'zustand'
import { canEdit, cancelPrompts, freezeTodos, clearSession, dropSuggestion, decidePermission, finishQuestion, gotoStep, initialClaude, newProcess, newSession, questionSteps, recordAnswer, reduceClaude, replaceFrom, userSent, type ClaudeState } from './reducer'
import { allowResponse, alwaysResponse, answerResponse, denyResponse, parsePermissionRequest } from './questions'
import type { FeedClaudeItem, PermissionDecision } from './reducer'
import { historyItems, type SessionHistory, type SessionInfo } from './resume'
import { GET_SETTINGS, effortRequest, modelNote, persistedModel, setModelRequest, type ModelChoice } from './models'
import { docOf } from '../attach/doc'
import { serialize } from '../attach/serialize'
import type { Attachment, Doc } from '../attach/types'
import type { ClaudePermissionMode } from '../settings/settings'
import { useSettings } from '../settings/store'

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
  /**
   * Режим разрешений, с которым запущен текущий процесс (из настроек на момент запуска;
   * смена настройки действует со следующего запуска). null — процесс ещё не запускался.
   */
  permissionMode: ClaudePermissionMode | null
  /**
   * Сообщения, набранные, пока ход шёл (как в Claude Code): ждут конца хода и уходят по одному
   * за ход. В ленте их нет, пока не отправлены.
   */
  queue: QueuedMessage[]
  /** Очередь не уходит сама (ход прерван ⌃C, claude завершился): ↵ на пустой строке — следующее. */
  paused: boolean
  /** Подсказка «пауза — ↵ отправить следующее» в заголовке очереди (esc убирает). */
  pauseHint: boolean
  /**
   * Правка сообщения: следующий запуск продолжает сессию с этого сообщения (`--resume-session-at`)
   * ответвлением (`--fork-session`). Сбрасывается запуском.
   */
  rewindAt?: string | null
  /**
   * `/exit`: Claude закрыт, как после выхода из claude в терминале — панели агентов и плашки нет,
   * карточки остаются в ленте. Следующий вопрос или `claude` начинает новую сессию.
   */
  closed?: boolean
  /**
   * Сессия восстановлена после перезапуска приложения: процесса ещё нет, следующий запуск —
   * с `--resume`, в ленте перед ним заметка «Разговор восстановлен · каталог».
   */
  restored?: boolean
}

export interface QueuedMessage {
  id: number
  /** Текст; со значками — TOKEN_CHAR на их местах. */
  text: string
  /** Значки вложений по порядку (едут с сообщением, ↑ возвращает их в строку). */
  tokens?: Attachment[]
  /** Каталог панели в момент набора (как у ⌘↵): сообщение уходит в сессию этого каталога. */
  cwd?: string
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
  return (
    useClaudeSessions.getState().sessions[paneId] ?? {
      state: initialClaude(),
      procId: null,
      cwd: null,
      model: null,
      effort: null,
      permissionMode: null,
      queue: [],
      paused: false,
      pauseHint: false,
      rewindAt: null,
    }
  )
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
/** Заметка в ленте: вложение не приложено (файл пропал), ушёл путь. */
export const NOT_ATTACHED = 'Не приложено, Claude получил путь'
/** ⌘↵ раньше, чем панель узнала свой каталог (OSC 7). */
export const NO_CWD = 'Каталог панели ещё неизвестен — повторите через секунду'

/** Заметка в ленте перед первым запуском восстановленной сессии. */
export const RESTORED_NOTE = 'Разговор восстановлен'

function noteRestored(paneId: string): void {
  const p = get(paneId)
  if (!p.restored) return
  patch(paneId, (x) => ({
    ...x,
    restored: false,
    state:
      x.state.sessionId !== null && x.cwd !== null
        ? { ...x.state, items: [...x.state.items, { type: 'note', text: `${RESTORED_NOTE} · ${x.cwd}` }] }
        : x.state,
  }))
}

function start(paneId: string): Proc {
  noteRestored(paneId)
  const proc: Proc = { ready: Promise.resolve(null), id: null, interrupted: false, chain: Promise.resolve() }
  const alive = () => procs.get(paneId) === proc
  const prev = get(paneId)
  const resume = prev.state.sessionId
  const { cwd, model, effort } = prev
  // Перезапуск после правки сообщения: с точки перед ним, в новой сессии-ответвлении.
  const rewindAt = resume !== null ? (prev.rewindAt ?? null) : null
  // Режим — из настроек на момент запуска; Rust проверяет его по списку (неизвестный — acceptEdits).
  // Перезапуск после правки сохраняет режим прежнего процесса.
  const permissionMode = (prev.rewindAt ? prev.permissionMode : null) ?? useSettings.getState().settings.claudePermissionMode
  // Подсказка следующего сообщения (`--prompt-suggestions`): из настроек на момент запуска.
  const promptSuggestions = useSettings.getState().settings.claudePromptSuggestions
  patch(paneId, (p) => ({ ...p, permissionMode, rewindAt: null, state: newProcess(p.state) }))
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
    const before = get(paneId).state.pending
    patchState(paneId, (s) => reduceClaude(s, line, Date.now()))
    // Ход закончился (не прерван) — следующее сообщение из очереди.
    if (before > 0 && get(paneId).state.pending === 0 && !proc.interrupted) sendNextQueued(paneId, undefined)
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
      if (!ok && resume !== null && !gotLine) state = newSession(state)
      // Вопрос без процесса не ответить: отменяем (блок над строкой ввода исчезает).
      state = cancelPrompts(state, undefined, 'exit')
      // Очередь не уходит сама в новый процесс: пауза до ↵.
      return { ...p, procId: null, state, ...pause(p) }
    })
  })
  const rewind = rewindAt ? { resumeAt: rewindAt, fork: true } : {}
  proc.ready = invoke<string>('claude_start', { cwd, resume, model, effort, permissionMode, ...rewind, promptSuggestions, onLine, onExit })
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
        patch(paneId, (p) => ({ ...p, procId: null, state: failed(p.state, String(err), Date.now()), ...pause(p) }))
      }
      return null
    })
  procs.set(paneId, proc)
  return proc
}

/** ⌃L: Claude-элементы до from ушли из ленты — их планы больше не обновляются на месте. */
export function feedCleared(paneId: string, from: number): void {
  if (!(paneId in useClaudeSessions.getState().sessions)) return
  patchState(paneId, (s) => freezeTodos(s, from))
}

/** Подсказку следующего сообщения убрали (набор, esc, вставка): до следующего хода её нет. */
export function dismissSuggestion(paneId: string): void {
  if (!useClaudeSessions.getState().sessions[paneId]?.state.suggestion) return
  patchState(paneId, dropSuggestion)
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

/** Пауза очереди (с подсказкой, если в ней что-то есть). */
const pause = (p: PaneClaude) => ({ paused: true, pauseHint: p.queue.length > 0 })

let queueSeq = 0

/** Следующее сообщение очереди — в Claude (снимает паузу). false — очередь пуста. */
function sendNextQueued(paneId: string, paneCwd: string | undefined): boolean {
  const cur = get(paneId)
  if (cur.paused || cur.queue.length === 0) return false
  const [head, ...rest] = cur.queue
  patch(paneId, (p) => ({ ...p, queue: rest }))
  void askClaude(paneId, head.cwd ?? paneCwd, head.text, head.tokens)
  return true
}

/** ↵ на пустой строке: следующее из очереди, если ход не идёт (после паузы). */
export function sendQueued(paneId: string, paneCwd: string | undefined): boolean {
  const cur = get(paneId)
  if (cur.state.busy || cur.queue.length === 0) return false
  patch(paneId, (p) => ({ ...p, paused: false, pauseHint: false }))
  return sendNextQueued(paneId, paneCwd)
}

/**
 * ↑ в пустой строке: последнее сообщение очереди — обратно в строку (из очереди убирается).
 * Без значков — текст, со значками — Doc (текст и значки).
 */
export function recallQueued(paneId: string): string | Doc | null {
  const q = get(paneId).queue
  if (q.length === 0) return null
  const last = q[q.length - 1]
  patch(paneId, (p) => ({ ...p, queue: p.queue.slice(0, -1), pauseHint: p.pauseHint && p.queue.length > 1 }))
  return last.tokens && last.tokens.length > 0 ? docOf(last.text, last.tokens) : last.text
}

/** ✕ / ⌫ на строке очереди. */
export function removeQueued(paneId: string, id: number): void {
  patch(paneId, (p) => {
    const queue = p.queue.filter((m) => m.id !== id)
    return { ...p, queue, pauseHint: p.pauseHint && queue.length > 0 }
  })
}

/** esc: убрать подсказку паузы (очередь остаётся на паузе). false — подсказки не было. */
export function dismissQueueHint(paneId: string): boolean {
  if (!get(paneId).pauseHint) return false
  patch(paneId, (p) => ({ ...p, pauseHint: false }))
  return true
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
    patch(paneId, (p) => ({ ...p, restored: false, state: { ...newSession(stopped(p.state, Date.now())), contextUsed: 0 } }))
  }
  if (cur.cwd !== cwd) patch(paneId, (p) => ({ ...p, cwd }))
  if (cur.closed) patch(paneId, (p) => ({ ...p, closed: false }))
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

/**
 * `/clear`: процесс панели останавливается, очередь и правка забываются, дальше — новая сессия
 * (без --resume). Модель и усилие из `/model` остаются.
 */
export function clearClaude(paneId: string): void {
  dropProc(paneId)
  patch(paneId, (p) => ({ ...p, procId: null, queue: [], paused: false, pauseHint: false, rewindAt: null, restored: false, state: clearSession(p.state) }))
}

/** `/resume`: прошлые разговоры каталога панели (новые первыми) и id текущего разговора панели. */
export async function listSessions(paneId: string, paneCwd: string | undefined): Promise<{ rows: SessionInfo[]; current: string | null }> {
  const cwd = paneCwd ?? get(paneId).cwd
  if (cwd === null) throw new Error(NO_CWD)
  const rows = await invoke<SessionInfo[]>('claude_sessions', { cwd })
  return { rows, current: get(paneId).state.sessionId }
}

/** Номер последнего `/resume` панели: история, дочитанная к более раннему, не применяется. */
const resumeSeqs = new Map<string, number>()

/**
 * `/resume` ↵: сначала читается история разговора; не прочиталась — текущий разговор остаётся,
 * в ленте карточка ошибки. Прочиталась — прежний процесс останавливается (как `/clear`),
 * onReplace(n) прячет в ленте элементы до n, история ложится карточками, процесс запускается
 * заново с `--resume <id>`. Два `/resume` подряд — применяется последний. Модель и усилие из
 * `/model` остаются. false — каталог неизвестен или чтение не удалось / устарело.
 */
export async function resumeClaude(
  paneId: string,
  paneCwd: string | undefined,
  s: SessionInfo,
  onReplace?: (from: number) => void,
): Promise<boolean> {
  const seq = (resumeSeqs.get(paneId) ?? 0) + 1
  resumeSeqs.set(paneId, seq)
  const cwd = paneCwd ?? get(paneId).cwd
  if (cwd === null) {
    patchState(paneId, (x) => failed(x, NO_CWD, Date.now()))
    return false
  }
  let history: SessionHistory
  try {
    history = await invoke<SessionHistory>('claude_session_history', { cwd, id: s.id })
  } catch (e) {
    if (resumeSeqs.get(paneId) === seq) addError(paneId, `Не удалось прочитать разговор: ${errText(e)}`)
    return false
  }
  if (resumeSeqs.get(paneId) !== seq) return false
  switchCwd(paneId, cwd)
  onReplace?.(get(paneId).state.items.length)
  clearClaude(paneId)
  patchState(paneId, (x) => ({
    ...x,
    sessionId: s.id,
    items: [...x.items, { type: 'session', cwd }, ...historyItems(s.title, history)],
  }))
  start(paneId)
  return true
}

/** `/exit`: закрыть Claude панели (процесс остановлен, сессия забыта); лента не трогается. */
export function exitClaude(paneId: string): void {
  if (!(paneId in useClaudeSessions.getState().sessions)) return
  clearClaude(paneId)
  patch(paneId, (p) => ({ ...p, closed: true }))
}

/** Сессия панели открыта (не закрыта `/exit`): видны панель агентов, плашка и точка вкладки. */
export const claudeOpen = (s: PaneClaude | undefined): s is PaneClaude => !!s && !s.closed

/** Каталог для сессии панели известен (из панели или прежней сессии): askClaude не упадёт на NO_CWD. */
export function claudeCwdKnown(paneId: string, paneCwd: string | undefined): boolean {
  return (paneCwd ?? get(paneId).cwd) !== null
}

/**
 * ⌘↵: вопрос в Claude-сессию панели. Карточка «Вы» — сразу; процесс запускается при первом
 * сообщении (и заново после выхода — с `--resume`, если id сессии известен). Если панель
 * с тех пор перешла в другой каталог — новая сессия там; начало новой сессии отмечается в ленте.
 */
export async function askClaude(paneId: string, paneCwd: string | undefined, text: string, tokens?: Attachment[]): Promise<void> {
  const toks = tokens && tokens.length > 0 ? tokens : undefined
  // Ход идёт (в т. ч. ждёт ответа на вопрос или разрешение) — в очередь: в stdin посреди хода не пишем.
  if (get(paneId).state.busy) {
    const msg: QueuedMessage = { id: ++queueSeq, text, ...(toks ? { tokens: toks } : {}), ...(paneCwd ? { cwd: paneCwd } : {}) }
    patch(paneId, (p) => ({ ...p, queue: [...p.queue, msg], pauseHint: p.pauseHint || p.paused }))
    return
  }
  return send(paneId, paneCwd, text, toks, false)
}

/** Отправка вопроса в простое (не в очередь). edit — правка сообщения: строку новой сессии не пишем. */
async function send(paneId: string, paneCwd: string | undefined, text: string, toks: Attachment[] | undefined, edit: boolean): Promise<void> {
  // Отправка вручную снимает паузу: после этого хода очередь снова уходит сама.
  patch(paneId, (p) => (p.paused ? { ...p, paused: false, pauseHint: false } : p))
  const cwd = switchCwd(paneId, paneCwd)
  if (cwd === null) {
    patchState(paneId, (s) => failed(userSent(s, text, Date.now(), toks), NO_CWD, Date.now()))
    return
  }
  // Новая сессия (не продолжение): в ленте — строка с её каталогом.
  if (!edit && !procs.has(paneId) && get(paneId).state.sessionId === null) {
    patchState(paneId, (s) => ({ ...s, items: [...s.items, { type: 'session', cwd }] }))
  }
  if (!procs.has(paneId)) noteRestored(paneId)
  patchState(paneId, (s) => userSent(s, text, Date.now(), toks))
  // Значки → текст и файлы (картинки и pdf base64 собирает Rust); пути — относительно каталога сессии.
  const out = toks ? serialize(docOf(text, toks), cwd) : { text, files: [] }
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
      const skipped = await invoke<string[] | undefined>('claude_send', { id, text: out.text, ...(out.files.length > 0 ? { files: out.files } : {}) })
      // Файл пропал между вставкой и отправкой: сообщение ушло с `@путь` вместо него — заметка.
      if (Array.isArray(skipped) && skipped.length > 0) {
        patchState(paneId, (s) => ({ ...s, items: [...s.items, ...skipped.map((r): FeedClaudeItem => ({ type: 'note', text: `${NOT_ATTACHED}: ${r}` }))] }))
      }
    } catch (err) {
      patch(paneId, (p) => ({ ...p, state: failed(p.state, String(err), Date.now()), ...pause(p) }))
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
  // Очередь остаётся, но сама не уходит: ↵ на пустой строке — следующее.
  patch(paneId, (p) => ({ ...p, ...pause(p) }))
  // Прерванный ход — его вопросы и разрешения больше не ждут.
  patchState(paneId, (s) => cancelPrompts(s))
  // Процесс ещё запускается — отметки достаточно: askClaude не отправит вопрос.
  if (proc.id) invoke('claude_interrupt', { id: proc.id }).catch(() => {})
  return true
}

/** Сколько ждать конца прерванного хода перед перезапуском (дальше процесс просто останавливается). */
export const SETTLE_MS = 5000

/** Ход прерван: ждём его конца (result или выход процесса), не дольше SETTLE_MS. */
function settled(paneId: string, proc: Proc): Promise<void> {
  const done = () => !get(paneId).state.busy || procs.get(paneId) !== proc
  if (done()) return Promise.resolve()
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      unsub()
      resolve()
    }
    const timer = setTimeout(finish, SETTLE_MS)
    const unsub = useClaudeSessions.subscribe(() => {
      if (done()) finish()
    })
  })
}

/** Идущая правка панели: вторая (двойной ↵) не начинается, пока первая не перезапустила процесс. */
const editing = new Set<string>()

/**
 * Правка отправленного сообщения index (↵ в режиме правки). Порядок: прервать ход, если идёт
 * (и дождаться его конца) → остановить процесс → запустить заново с точки перед сообщением
 * (`--resume <сессия> --resume-session-at <uuid> --fork-session`; первое сообщение — новая сессия)
 * → отправить исправленный текст. В ленте прежний вариант сворачивается на месте сообщения.
 * Очередь остаётся и уходит после нового ответа. false — сообщение изменить нельзя.
 */
export async function editClaude(paneId: string, index: number, text: string, tokens?: Attachment[]): Promise<boolean> {
  if (editing.has(paneId) || !canEdit(get(paneId).state, index)) return false
  editing.add(paneId)
  try {
    const proc = procs.get(paneId)
    if (proc && get(paneId).state.busy) {
      // Как ⌃C, но очередь не ставится на паузу: она уйдёт после исправленного ответа.
      proc.interrupted = true
      patchState(paneId, (s) => cancelPrompts(s))
      if (proc.id) {
        await invoke('claude_interrupt', { id: proc.id }).catch(() => {})
        await settled(paneId, proc)
      }
    }
    // Пока ждали, сессия могла смениться (другой каталог) — тогда это сообщение уже не правится.
    const cur = get(paneId)
    const point = cur.state.edits[index]?.at
    if (!canEdit(cur.state, index) || !point) return false
    dropProc(paneId)
    const at = point === 'fresh' ? null : point
    patch(paneId, (p) => ({
      ...p,
      procId: null,
      paused: false,
      pauseHint: false,
      rewindAt: at ? at.uuid : null,
      state: {
        ...replaceFrom(cancelPrompts(stopped(p.state, Date.now()), undefined, 'stop'), index),
        // Продолжаем ту сессию, где была точка (её файл цел), — или начинаем новую с первого сообщения.
        sessionId: at ? at.session : null,
        chain: at,
      },
    }))
    const toks = tokens && tokens.length > 0 ? tokens : undefined
    await send(paneId, cur.cwd ?? undefined, text, toks, true)
    return true
  } finally {
    editing.delete(paneId)
  }
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
