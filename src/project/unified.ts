import type { Hunk } from '../claude/diff'

export interface ParsedDiff {
  hunks: Hunk[]
  add: number
  del: number
  /** Вывод git_diff урезан бэкендом (лимит размера). */
  truncated: boolean
  /** Неотслеживаемый файл больше лимита чтения: показано только начало (метка бэкенда «\ Файл усечён»). */
  fileCut: boolean
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/
const TRUNC_MARK = '\\ Изменения урезаны'
const FILE_CUT_MARK = '\\ Файл усечён'

/** Разбор unified diff одного файла в куски как у structuredPatch (строки с префиксом ' ', '-', '+'). */
export function parseUnified(text: string): ParsedDiff {
  const hunks: Hunk[] = []
  let add = 0
  let del = 0
  let truncated = false
  let fileCut = false
  let cur: Hunk | null = null
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  for (const line of lines) {
    if (line.startsWith(TRUNC_MARK)) {
      truncated = true
      continue
    }
    if (line.startsWith(FILE_CUT_MARK)) {
      fileCut = true
      continue
    }
    const m = HUNK.exec(line)
    if (m) {
      cur = { oldStart: Number(m[1]), newStart: Number(m[2]), lines: [] }
      hunks.push(cur)
      continue
    }
    // Заголовки (diff --git, index, ---, +++) до первого куска игнорируем.
    if (!cur) continue
    // «\ No newline at end of file» — не строка файла.
    if (line.startsWith('\\')) continue
    const c = line[0]
    if (c === '+') add++
    else if (c === '-') del++
    else if (c !== ' ') {
      // Пустая строка вместо « » (редакторы режут хвостовые пробелы) — контекст.
      if (line !== '') continue
      cur.lines.push(' ')
      continue
    }
    cur.lines.push(line)
  }
  return { hunks, add, del, truncated, fileCut }
}
