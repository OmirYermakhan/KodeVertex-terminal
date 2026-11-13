// `/resume` в режиме карточек: выбор прошлого разговора каталога панели (как `/model` —
// карточка над строкой ввода) и его история в ленте (сообщения «Вы» и ответы, компактно).
import { messagesLabel, type FeedClaudeItem } from './reducer'

/** Ответ `claude_sessions` (Rust): разговор каталога. */
export interface SessionInfo {
  id: string
  /** Первое сообщение пользователя одной строкой. */
  title: string
  /** Время изменения файла разговора, мс. */
  modified: number
  messages: number
  /** Файл прочитан не целиком: сообщений не меньше messages. */
  partial: boolean
}

/** Ответ `claude_session_history`: последние ходы разговора. */
export interface SessionHistory {
  messages: { role: 'user' | 'assistant'; text: string }[]
  /** Более ранних сообщений не загружено. */
  skipped: number
  /** Итог стоимости разговора по CLI (последняя запись `cost-state`); null — неизвестен. */
  cost?: number | null
}

export interface ResumeState {
  /** null — список ещё читается. */
  rows: SessionInfo[] | null
  /** Ошибка чтения списка. */
  error: string | null
  selected: number
}

export type ResumeAction = { kind: 'choose'; session: SessionInfo } | { kind: 'cancel' }

export const initialResume = (): ResumeState => ({ rows: null, error: null, selected: 0 })

/** Клавиши карточки: ↑↓ и 1–9 — выбор, ↵ — продолжить, esc — отмена. */
export function resumeKey(
  s: ResumeState,
  key: string,
): { state: ResumeState; action: ResumeAction | null; handled: boolean } {
  const rows = s.rows ?? []
  const n = rows.length
  const done = (state: ResumeState, action: ResumeAction | null = null) => ({ state, action, handled: true })
  switch (key) {
    case 'ArrowDown':
      return done(n > 0 ? { ...s, selected: (s.selected + 1) % n } : s)
    case 'ArrowUp':
      return done(n > 0 ? { ...s, selected: (s.selected - 1 + n) % n } : s)
    case 'Enter':
      return done(s, n > 0 ? { kind: 'choose', session: rows[Math.min(s.selected, n - 1)] } : null)
    case 'Escape':
      return done(s, { kind: 'cancel' })
  }
  if (/^[1-9]$/.test(key) && Number(key) <= n) return done({ ...s, selected: Number(key) - 1 })
  return { state: s, action: null, handled: false }
}

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** Когда разговор менялся: «только что», «5 мин назад», «3 ч назад», «вчера», «4 дн назад», дата. */
export function ago(t: number, now: number): string {
  const d = now - t
  if (d < MIN) return 'только что'
  if (d < HOUR) return `${Math.floor(d / MIN)} мин назад`
  if (d < DAY) return `${Math.floor(d / HOUR)} ч назад`
  if (d < 2 * DAY) return 'вчера'
  if (d < 7 * DAY) return `${Math.floor(d / DAY)} дн назад`
  const date = new Date(t)
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  return date.toLocaleDateString('ru-RU', sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' })
}

/** Пояснение строки: «5 мин назад · 14 сообщений» (файл не дочитан — «14+ сообщений»). */
export function sessionDetail(s: SessionInfo, now: number): string {
  const label = messagesLabel(s.messages)
  return `${ago(s.modified, now)} · ${s.partial ? label.replace(' ', '+ ') : label}`
}

/** Заметка в ленте перед историей продолжённого разговора. */
export const RESUMED_NOTE = 'Разговор продолжен'

/** Элементы ленты из истории: заметка, «… ещё N раньше», затем сообщения (ответы — главного агента). */
export function historyItems(title: string, h: SessionHistory): FeedClaudeItem[] {
  const out: FeedClaudeItem[] = [{ type: 'note', text: `${RESUMED_NOTE} · ${title}` }]
  if (h.skipped > 0) out.push({ type: 'note', text: `… раньше ещё ${messagesLabel(h.skipped)}` })
  for (const m of h.messages) {
    out.push(m.role === 'user' ? { type: 'user', text: m.text } : { type: 'assistant', agentId: 'main', text: m.text, streaming: false })
  }
  return out
}
