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
  /** Пользователь прервал ход (⌃C): выход процесса после этого — не ошибка. */
  interrupted: boolean
}
const procs = new Map<string, Proc>()

function get(paneId: string): PaneClaude {
  return useClaudeSessions.getState().sessions[paneId] ?? { state: initialClaude(), procId: null }
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
    currentAgentId: null,
    agents: s.agents.map((a) => (a.status === 'running' ? { ...a, status: 'done', now: 'Остановлено', endedAt: now } : a)),
  }
}

export function exitMessage(e: ClaudeExit): string {
  const tail = e.stderr.trimEnd().split('\n').slice(-STDERR_LINES).join('\n').trim()
  const head = e.code === null ? 'Claude Code завершился аварийно' : `Claude Code завершился с кодом ${e.code}`
  return tail ? `${head}:\n${tail}` : head
}

function start(paneId: string, cwd: string | undefined): Proc {
  const proc: Proc = { ready: Promise.resolve(null), id: null, interrupted: false }
  const alive = () => procs.get(paneId) === proc
  const onLine = new Channel<string>((line) => {
    if (alive()) patchState(paneId, (s) => reduceClaude(s, line, Date.now()))
  })
  const onExit = new Channel<ClaudeExit>((e) => {
    if (!alive()) return
    procs.delete(paneId)
    const ok = e.code === 0 || proc.interrupted
    patch(paneId, (p) => ({
      procId: null,
      state: ok ? stopped(p.state, Date.now()) : failed(p.state, exitMessage(e), Date.now()),
    }))
  })
  const resume = get(paneId).state.sessionId
  proc.ready = invoke<string>('claude_start', { cwd: cwd ?? null, resume, onLine, onExit })
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
        patch(paneId, (p) => ({ procId: null, state: failed(p.state, String(err), Date.now()) }))
      }
      return null
    })
  procs.set(paneId, proc)
  return proc
}

/**
 * ⌘↵: вопрос в Claude-сессию панели. Карточка «Вы» — сразу; процесс запускается при первом
 * сообщении (и заново после выхода — с `--resume`, если id сессии известен).
 */
export async function askClaude(paneId: string, cwd: string | undefined, text: string): Promise<void> {
  patchState(paneId, (s) => userSent(s, text, Date.now()))
  const proc = procs.get(paneId) ?? start(paneId, cwd)
  proc.interrupted = false
  const id = await proc.ready
  if (id === null || procs.get(paneId) !== proc) return
  try {
    await invoke('claude_send', { id, text })
  } catch (err) {
    patchState(paneId, (s) => failed(s, String(err), Date.now()))
  }
}

/** ⌃C: прервать текущий ход Claude. false — Claude не занят, прерывать нечего. */
export function interruptClaude(paneId: string): boolean {
  const proc = procs.get(paneId)
  if (!get(paneId).state.busy || !proc?.id) return false
  proc.interrupted = true
  invoke('claude_interrupt', { id: proc.id }).catch(() => {})
  return true
}

/** Панель закрыта: процесс остановить, состояние забыть. */
export function stopClaude(paneId: string): void {
  const proc = procs.get(paneId)
  procs.delete(paneId)
  if (proc?.id) invoke('claude_stop', { id: proc.id }).catch(() => {})
  useClaudeSessions.setState((st) => {
    if (!(paneId in st.sessions)) return st
    const sessions = { ...st.sessions }
    delete sessions[paneId]
    return { sessions }
  })
}
