// События Claude-сессий для тех, кто следит за файлами (панель проекта): закончились действия,
// меняющие файлы, или началась новая сессия. Модуль Claude не знает о подписчиках.
import type { ClaudeState } from './reducer'

/** Инструменты, после которых файлы проекта могли измениться. */
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'])

export interface FinishedTool {
  tool: string
  /** Абсолютный путь правленого файла; null — у Bash (что поменялось — неизвестно). */
  path: string | null
  ok: boolean
}

export type ClaudeEvent =
  | { kind: 'tools'; tools: FinishedTool[] }
  /** Новая сессия (/clear): «Claude менял» считается заново. */
  | { kind: 'cleared' }

/** Действия, меняющие файлы, которые между before и after перешли из «идёт» в «готово»/«ошибка». */
export function finishedTools(before: ClaudeState, after: ClaudeState): FinishedTool[] {
  if (before.items === after.items) return []
  const running = new Set<string>()
  for (const it of before.items) if (it.type === 'action' && it.status === 'running' && FILE_TOOLS.has(it.tool)) running.add(it.toolUseId)
  if (running.size === 0) return []
  const out: FinishedTool[] = []
  for (const it of after.items) {
    if (it.type !== 'action' || it.status === 'running' || !running.has(it.toolUseId)) continue
    out.push({ tool: it.tool, path: it.tool === 'Bash' ? null : it.detail || null, ok: it.status === 'done' })
  }
  return out
}

type Listener = (e: ClaudeEvent) => void
const listeners = new Set<Listener>()

export function onClaudeEvent(f: Listener): () => void {
  listeners.add(f)
  return () => {
    listeners.delete(f)
  }
}

export function emitClaudeEvent(e: ClaudeEvent): void {
  for (const f of listeners) f(e)
}
