// Claude-сессии панелей: процесс `claude` на панель, его состояние (ClaudeState) — в сторе по paneId,
// чтобы его читали лента панели, панель агентов и статус-бар.
import { Channel, invoke } from '@tauri-apps/api/core'
import { create } from 'zustand'
import { initialClaude, reduceClaude, userSent, type ClaudeState } from './reducer'

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
  return useClaudeSessions.getState().sessions[paneId] ?? { state: initialClaude(), procId: null, cwd: null }
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
      a.id === 'main' && a.status === 'running' ? { ...a, status: 'error', now: 'Ошибка', endedAt: now } : a,
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
    agents: s.agents.map((a) => (a.status === 'running' ? { ...a, status: 'done', now: 'Остановлено', endedAt: now } : a)),
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
  const cwd = prev.cwd
  let gotLine = false
  const onLine = new Channel<string>((line) => {
    gotLine = true
    if (alive()) patchState(paneId, (s) => reduceClaude(s, line, Date.now()))
  })
  const onExit = new Channel<ClaudeExit>((e) => {
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
      return { ...p, procId: null, state }
    })
  })
  proc.ready = invoke<string>('claude_start', { cwd, resume, onLine, onExit })
    .then((id) => {
      if (!alive()) {
        // Панель закрыли, пока процесс запускался.
        invoke('claude_stop', { id }).catch(() => {})
        return null
      }
      proc.id = id
      patch(paneId, (p) => ({ ...p, procId: id }))
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
export function enterClaude(paneId: string, paneCwd: string | undefined): void {
  const cwd = switchCwd(paneId, paneCwd)
  if (cwd === null) {
    patchState(paneId, (s) => failed(s, NO_CWD, Date.now()))
    return
  }
  patchState(paneId, (s) => ({ ...s, items: [...s.items, { type: 'session', cwd, mode: true }] }))
  if (!procs.has(paneId)) start(paneId)
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

/** ⌃C: прервать текущий ход Claude. false — Claude не занят, прерывать нечего. */
export function interruptClaude(paneId: string): boolean {
  const proc = procs.get(paneId)
  if (!get(paneId).state.busy || !proc) return false
  proc.interrupted = true
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
