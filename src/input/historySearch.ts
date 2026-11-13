// Подсказка-призрак (как fish/Warp) по истории строки ввода.

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
