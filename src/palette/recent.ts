// Недавние команды палитры ⌘P — в localStorage (нет доступа — только в памяти до перезапуска).
const KEY = 'kv.palette.recent'
export const RECENT_MAX = 8

let memory: string[] | null = null

export function loadRecent(): string[] {
  if (memory) return memory
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    memory = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, RECENT_MAX) : []
  } catch {
    memory = []
  }
  return memory
}

/** Команда выполнена: в начало списка. */
export function pushRecent(id: string): void {
  memory = [id, ...loadRecent().filter((x) => x !== id)].slice(0, RECENT_MAX)
  try {
    localStorage.setItem(KEY, JSON.stringify(memory))
  } catch {
    // Хранилище недоступно — список живёт в памяти.
  }
}

/** Для тестов: забыть то, что в памяти (следующее чтение — из хранилища). */
export function resetRecent(): void {
  memory = null
}
