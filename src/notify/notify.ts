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

const trim60 = (t: string) => {
  const one = t.replace(/\s+/g, ' ').trim()
  return one.length > 60 ? one.slice(0, 59).trimEnd() + '…' : one
}

/** Последний вопрос пользователя в сессии (что делал главный агент). */
export function lastQuestion(items: { type: string; text?: string }[]): string {
  for (let i = items.length - 1; i >= 0; i--) if (items[i].type === 'user') return items[i].text ?? ''
  return ''
}

/**
 * «Закончил: что»: у главного — последний вопрос пользователя (до ~60 знаков); у субагента имя уже
 * взято из description задачи, отдельного поля нет — берём последнее действие из истории.
 */
export function agentText(ev: AgentEvent, question = ''): string {
  const { agent, kind } = ev
  if (kind === 'waiting') return `${MARK.waiting} ${agent.name} ждёт ответа`
  if (kind === 'error') return `${MARK.error} ${agent.name}: ошибка`
  const last = agent.history[agent.history.length - 1]
  const what = agent.id === 'main' ? trim60(question) : last ? pastLabel(last) : ''
  return `${MARK.done} ${agent.name} закончил${what ? `: ${what}` : ''}`
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
/** Контекст создаётся лениво и возобновляется: без жеста WKWebView держит его в 'suspended'. */
export function audioContext(): AudioContext | null {
  try {
    audio ??= new AudioContext()
    if (audio.state === 'suspended') void audio.resume()
    return audio
  } catch {
    return null
  }
}

/** Короткий тихий тон; «готово» — выше, «ждёт» — ниже. */
function beep(kind: NotifyKind): void {
  try {
    const ctx = audioContext()
    if (!ctx) return
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

export const FOCUS_NAV_MS = 30_000
let pending: { toast: Omit<Toast, 'id'>; at: number } | null = null

/** Окно получило фокус: если недавно было системное уведомление — перейти к его вкладке/агенту. */
export function handleWindowFocus(): void {
  const p = pending
  pending = null
  if (!p || Date.now() - p.at > FOCUS_NAV_MS) return
  useTabs.getState().focus(p.toast.paneId)
  if (p.toast.agentId) useUi.getState().requestAgent(p.toast.paneId, p.toast.agentId)
}

/** Показать событие: тост всегда; система и звук — по настройкам и правилам. */
export function emit(kind: NotifyKind, text: string, paneId: string, agentId: string | null): void {
  const s = useSettings.getState().settings
  const inActive = isInActiveTab(paneId)
  useToasts.getState().push({ kind, text, paneId, agentId })
  if (s.notifySound && soundFor(kind)) beep(kind)
  if (s.notifySystem && needsSystemNotice(document.hasFocus(), inActive)) {
    pending = { toast: { kind, text, paneId, agentId }, at: Date.now() }
    void systemNotice(text)
  }
}

function isInActiveTab(paneId: string): boolean {
  const { tabs, active } = useTabs.getState()
  const tab = tabs.find((t) => t.id === active)
  return !!tab && leaves(tab.tree).includes(paneId)
}

/** Завершилась shell-команда: долгая — уведомление. */
export function notifyCommandEnd(paneId: string, command: string, durationMs: number, exitCode: number, usedAlt = false): void {
  // vim, less, ssh на весь экран — не «долгая команда».
  if (usedAlt) return
  if (!shouldNotifyCommand(durationMs, useSettings.getState().settings)) return
  emit(exitCode === 0 ? 'done' : 'error', commandText(command, durationMs, exitCode), paneId, null)
}

/** Подписка на сессии Claude: тосты по переходам статусов и счётчик в Dock. */
export function installNotifications(): () => void {
  let lastBadge = -1
  const wake = () => void audioContext()
  window.addEventListener('keydown', wake, { once: true, capture: true })
  window.addEventListener('pointerdown', wake, { once: true, capture: true })
  window.addEventListener('focus', handleWindowFocus)
  const unsub = useClaudeSessions.subscribe((st, prev) => {
    const settings = useSettings.getState().settings
    for (const [paneId, s] of Object.entries(st.sessions)) {
      const before = prev.sessions[paneId]?.state.agents
      if (before === s.state.agents) continue
      for (const ev of agentEvents(before ?? [], s.state.agents)) {
        if (shouldNotifyAgent(ev, settings)) emit(ev.kind, agentText(ev, lastQuestion(s.state.items)), paneId, ev.agent.id)
      }
    }
    const n = waitingCount(st.sessions)
    if (n !== lastBadge) {
      lastBadge = n
      getCurrentWindow().setBadgeCount(n > 0 ? n : undefined).catch(() => {})
    }
  })
  return () => {
    unsub()
    window.removeEventListener('keydown', wake, true)
    window.removeEventListener('pointerdown', wake, true)
    window.removeEventListener('focus', handleWindowFocus)
  }
}
