// Состояние Claude во вкладке — для точки на вкладке (макет 04-main-window `.tab i`).
import { leaves } from '../layout/paneTree'
import type { Tab } from '../layout/tabsStore'
import type { ClaudeState } from '../claude/reducer'
import type { PaneClaude } from '../claude/sessionStore'

export type ClaudeStatus = 'running' | 'waiting' | 'done' | 'error'

/** Состояние сессии панели; null — сессия ещё ничего не делала. */
export function sessionStatus(s: ClaudeState): { status: ClaudeStatus; doneAt: number } | null {
  const main = s.agents.find((a) => a.id === 'main')
  if (main?.status === 'error') return { status: 'error', doneAt: main.endedAt ?? 0 }
  // Начальный «waiting» главного агента (startedAt 0) — не ожидание ответа.
  if (s.agents.some((a) => a.status === 'waiting' && a.startedAt > 0)) return { status: 'waiting', doneAt: 0 }
  if (s.busy) return { status: 'running', doneAt: 0 }
  if (main?.status === 'done') return { status: 'done', doneAt: main.endedAt ?? 0 }
  return null
}

const RANK: Record<ClaudeStatus, number> = { error: 3, waiting: 2, running: 1, done: 0 }

/** Сводка по всем панелям вкладки: ошибка > ждёт > работает > готово. */
export function tabStatus(tab: Tab, sessions: Record<string, PaneClaude>): { status: ClaudeStatus; doneAt: number } | null {
  let best: { status: ClaudeStatus; doneAt: number } | null = null
  for (const id of leaves(tab.tree)) {
    const s = sessions[id]
    const st = s ? sessionStatus(s.state) : null
    if (!st) continue
    if (!best || RANK[st.status] > RANK[best.status]) best = st
    else if (st.status === 'done' && best.status === 'done') best = { status: 'done', doneAt: Math.max(best.doneAt, st.doneAt) }
  }
  return best
}
