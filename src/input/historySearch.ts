// Подсказка-призрак (как fish/Warp) и поиск ⌃R по истории строки ввода.
import { fuzzyScore } from '../completion/completion'

export const SEARCH_LIMIT = 200

/** Подсказка клавиш поиска ⌃R. */
export function historyKeys(claude: boolean): string {
  return `↑↓ выбрать · ⌃R дальше · ⇥ изменить · ↵ ${claude ? 'отправить' : 'выполнить'} · esc закрыть`
}

/** Поиск ⌃R: записи новыми первыми, без повторов, нечёткое совпадение с запросом. */
export function searchHistory(list: readonly string[], query: string, limit = SEARCH_LIMIT): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (let i = list.length - 1; i >= 0 && out.length < limit; i--) {
    const c = list[i]
    if (!c.trim() || seen.has(c)) continue
    seen.add(c)
    if (fuzzyScore(query, c) !== null) out.push(c)
  }
  return out
}

/** Остаток самой свежей записи истории, начинающейся с набранного; null — подсказки нет. */
export function ghostSuggestion(list: readonly string[], text: string): string | null {
  if (text === '' || text.includes('\n')) return null
  for (let i = list.length - 1; i >= 0; i--) {
    const c = list[i]
    if (c.length > text.length && c.startsWith(text) && !c.includes('\n')) return c.slice(text.length)
  }
  return null
}

/** Следующее слово подсказки (⌥→): пробелы перед ним и само слово до пробела или после `/`. */
export function nextWord(rest: string): string {
  const m = /^\s*[^\s/]*\/?/.exec(rest)
  const w = m ? m[0] : ''
  return w === '' ? rest.slice(0, 1) : w
}
