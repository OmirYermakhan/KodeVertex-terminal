// Уведомления (спека §4.7): о завершении агента, ожидании ответа, ошибке и долгой shell-команде.
// Правила «когда уведомлять» — чистые функции; побочные эффекты (тост, системное уведомление,
// звук, значок Dock) — в `installNotifications`.
import { getCurrentWindow } from '@tauri-apps/api/window'
import { create } from 'zustand'
import type { Agent } from '../claude/reducer'
import { pastLabel } from '../claude/AgentsPanel'
import { useClaudeSessions } from '../claude/sessionStore'
import { leaves } from '../layout/paneTree'
import { useTabs } from '../layout/tabsStore'
import { useSettings } from '../settings/store'
import type { Settings } from '../settings/settings'
import { useUi } from '../ui/uiStore'

export type NotifyKind = 'done' | 'waiting' | 'error'

export const TOAST_MS = 6000
export const LONG_COMMAND_MS = 10_000

export interface AgentEvent {
  kind: NotifyKind
  agent: Agent
}

/** Переходы статусов агентов между двумя состояниями сессии. */
export function agentEvents(prev: Agent[], next: Agent[]): AgentEvent[] {
  const before = new Map(prev.map((a) => [a.id, a]))
  const out: AgentEvent[] = []
  for (const a of next) {
    const was = before.get(a.id)
    if (was?.status === a.status) continue
    if (a.status === 'waiting' && a.startedAt > 0) out.push({ kind: 'waiting', agent: a })
    // Остановленный пользователем (⌃C) агент — не «закончил».
    else if (a.status === 'done' && a.now !== 'Остановлено') out.push({ kind: 'done', agent: a })
    else if (a.status === 'error') out.push({ kind: 'error', agent: a })
  }
  return out
}

type NotifySettings = Pick<Settings, 'notifySubagents'>

/** Главный агент — всегда; «ждёт вас» — от любого; остальное от субагентов — по настройке. */
export function shouldNotifyAgent(ev: AgentEvent, s: NotifySettings): boolean {
  if (ev.kind === 'waiting') return true
  return ev.agent.id === 'main' || s.notifySubagents
}

/** Долгая команда: > 10 с и включено в настройках. */
export function shouldNotifyCommand(durationMs: number | null, s: Pick<Settings, 'notifyLongCommands'>): boolean {
  return s.notifyLongCommands && durationMs !== null && durationMs > LONG_COMMAND_MS
}

/** Системное уведомление: окно не в фокусе или событие не в текущей вкладке. */
export function needsSystemNotice(windowFocused: boolean, inActiveTab: boolean): boolean {
  return !windowFocused || !inActiveTab
}

/** Звук — только на «готово» и «ждёт». */
export const soundFor = (kind: NotifyKind) => kind === 'done' || kind === 'waiting'

const MARK: Record<NotifyKind, string> = { done: '✓', waiting: '!', error: '✕' }

export function agentText(ev: AgentEvent): string {
  const { agent, kind } = ev
  if (kind === 'waiting') return `${MARK.waiting} ${agent.name} ждёт ответа`
  if (kind === 'error') return `${MARK.error} ${agent.name}: ошибка`
  const last = agent.history[agent.history.length - 1]
  return `${MARK.done} ${agent.name} закончил${last ? `: ${pastLabel(last)}` : ''}`
}

export function commandText(command: string, durationMs: number, exitCode: number): string {
  const c = command.length > 40 ? command.slice(0, 39) + '…' : command
  const t = `${(durationMs / 1000).toFixed(1).replace('.', ',')} с`
  return exitCode === 0 ? `${MARK.done} ${c} · ${t}` : `${MARK.error} ${c} · код ${exitCode} · ${t}`
}

/** Число агентов, ждущих ответа, по всем панелям (значок Dock). */
export function waitingCount(sessions: Record<string, { state: { agents: Agent[] } }>): number {
  let n = 0
  for (const s of Object.values(sessions)) for (const a of s.state.agents) if (a.status === 'waiting' && a.startedAt > 0) n++
  return n
}

export interface Toast {
  id: number
  kind: NotifyKind
  text: string
  paneId: string
  agentId: string | null
}

interface ToastStore {
  toasts: Toast[]
  push(t: Omit<Toast, 'id'>): void
  dismiss(id: number): void
}

let nextId = 1
export const useToasts = create<ToastStore>((set, get) => ({
  toasts: [],
  push: (t) => {
    const id = nextId++
    set((s) => ({ toasts: [...s.toasts, { ...t, id }] }))
    setTimeout(() => get().dismiss(id), TOAST_MS)
  },
  dismiss: (id) => set((s) => (s.toasts.some((t) => t.id === id) ? { toasts: s.toasts.filter((t) => t.id !== id) } : s)),
}))

/** Клик по тосту: вкладка, панель, агент в панели агентов. */
export function openToast(t: Toast): void {
  useTabs.getState().focus(t.paneId)
  if (t.agentId) useUi.getState().requestAgent(t.paneId, t.agentId)
  useToasts.getState().dismiss(t.id)
}

let audio: AudioContext | null = null
/** Короткий тихий тон; «готово» — выше, «ждёт» — ниже. */
function beep(kind: NotifyKind): void {
  try {
    audio ??= new AudioContext()
    const ctx = audio
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.frequency.value = kind === 'done' ? 880 : 660
    gain.gain.setValueAtTime(0.0001, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.06, ctx.currentTime + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25)
    osc.connect(gain).connect(ctx.destination)
    osc.start()
    osc.stop(ctx.currentTime + 0.27)
  } catch {
    // Нет WebAudio — без звука.
  }
}

async function systemNotice(text: string): Promise<void> {
  try {
    const n = await import('@tauri-apps/plugin-notification')
    let ok = await n.isPermissionGranted()
    if (!ok) ok = (await n.requestPermission()) === 'granted'
    if (ok) n.sendNotification({ title: 'KodeVertex', body: text })
  } catch {
    // Вне Tauri или без разрешения — только тост.
  }
}

/** Показать событие: тост всегда; система и звук — по настройкам и правилам. */
export function emit(kind: NotifyKind, text: string, paneId: string, agentId: string | null): void {
  const s = useSettings.getState().settings
  const inActive = isInActiveTab(paneId)
  useToasts.getState().push({ kind, text, paneId, agentId })
  if (s.notifySound && soundFor(kind)) beep(kind)
  if (s.notifySystem && needsSystemNotice(document.hasFocus(), inActive)) void systemNotice(text)
}

function isInActiveTab(paneId: string): boolean {
  const { tabs, active } = useTabs.getState()
  const tab = tabs.find((t) => t.id === active)
  return !!tab && leaves(tab.tree).includes(paneId)
}

/** Завершилась shell-команда: долгая — уведомление. */
export function notifyCommandEnd(paneId: string, command: string, durationMs: number, exitCode: number): void {
  if (!shouldNotifyCommand(durationMs, useSettings.getState().settings)) return
  emit(exitCode === 0 ? 'done' : 'error', commandText(command, durationMs, exitCode), paneId, null)
}

/** Подписка на сессии Claude: тосты по переходам статусов и счётчик в Dock. */
export function installNotifications(): () => void {
  let lastBadge = -1
  const unsub = useClaudeSessions.subscribe((st, prev) => {
    const settings = useSettings.getState().settings
    for (const [paneId, s] of Object.entries(st.sessions)) {
      const before = prev.sessions[paneId]?.state.agents
      if (before === s.state.agents) continue
      for (const ev of agentEvents(before ?? [], s.state.agents)) {
        if (shouldNotifyAgent(ev, settings)) emit(ev.kind, agentText(ev), paneId, ev.agent.id)
      }
    }
    const n = waitingCount(st.sessions)
    if (n !== lastBadge) {
      lastBadge = n
      getCurrentWindow().setBadgeCount(n > 0 ? n : undefined).catch(() => {})
    }
  })
  return unsub
}
