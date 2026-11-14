// Просмотр изменений файла (Edit/Write/MultiEdit): строки с номерами «было/стало», 3 строки
// контекста, длинные неизменные куски свёрнуты в «… N строк без изменений».
// Источники: structuredPatch из результата инструмента (настоящие номера строк) или, пока
// результата нет, сравнение old_string/new_string (номера неизвестны).

/** Кусок unified diff, как в `structuredPatch` Claude Code: строки с префиксом ' ', '-', '+'. */
export interface Hunk {
  oldStart: number
  newStart: number
  lines: string[]
}

export interface FileDiff {
  path: string
  before: string
  after: string
  /** Куски с номерами строк из результата инструмента; нет — номера неизвестны. */
  hunks?: Hunk[]
  /** Файл до правки (из результата, если не слишком большой): разворачивает свёрнутые строки. */
  original?: string
  /** Write создал новый файл: всё — добавленные строки с 1. */
  created?: boolean
  /** MultiEdit до результата: правки по отдельности (между ними — неизвестное число строк). */
  parts?: { before: string; after: string }[]
  /** Текст урезан при сохранении сессии (boundDiff): показываются только первые строки. */
  truncated?: boolean
  /** Счётчики «+A −D» полного изменения — у урезанного вида свои не сходятся. */
  stat?: { add: number; del: number }
}

export type RowKind = 'a' | 'd' | 'n'
export interface DiffRow {
  k: RowKind
  /** Номер строки в файле до правки / после; нет — не применимо или неизвестно. */
  o?: number
  n?: number
  t: string
}

/** Строка вида или свёрнутый кусок: count строк (null — сколько, неизвестно), rows — если их можно показать. */
export type DiffPart = { kind: 'row'; row: DiffRow } | { kind: 'gap'; count: number | null; rows: DiffRow[] | null }

export const CONTEXT = 3
/** Размер исходного файла, который ещё храним в ленте для разворота свёрнутых строк. */
export const ORIGINAL_MAX = 64 * 1024

const splitLines = (s: string): string[] => (s === '' ? [] : s.replace(/\n$/, '').split('\n'))

/** Ниже — квадратичный LCS; больше — только общие начало и конец. */
const LCS_MAX = 2_000_000

/** Построчное сравнение (LCS): общие строки — 'n', остальные — 'd'/'a' (удалённые перед добавленными). */
export function lineDiff(before: string, after: string): DiffRow[] {
  const b = splitLines(before)
  const a = splitLines(after)
  let pre = 0
  while (pre < b.length && pre < a.length && b[pre] === a[pre]) pre++
  let suf = 0
  while (suf < b.length - pre && suf < a.length - pre && b[b.length - 1 - suf] === a[a.length - 1 - suf]) suf++
  const out: DiffRow[] = b.slice(0, pre).map((t) => ({ k: 'n', t }))
  const mb = b.slice(pre, b.length - suf)
  const ma = a.slice(pre, a.length - suf)
  if (mb.length * ma.length > LCS_MAX || mb.length === 0 || ma.length === 0) {
    for (const t of mb) out.push({ k: 'd', t })
    for (const t of ma) out.push({ k: 'a', t })
  } else {
    // dp[i][j] — длина LCS хвостов mb[i..], ma[j..].
    const w = ma.length + 1
    const dp = new Uint32Array((mb.length + 1) * w)
    for (let i = mb.length - 1; i >= 0; i--)
      for (let j = ma.length - 1; j >= 0; j--)
        dp[i * w + j] = mb[i] === ma[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1])
    let i = 0
    let j = 0
    const dels: DiffRow[] = []
    const adds: DiffRow[] = []
    const flush = () => {
      out.push(...dels, ...adds)
      dels.length = 0
      adds.length = 0
    }
    while (i < mb.length || j < ma.length) {
      if (i < mb.length && j < ma.length && mb[i] === ma[j]) {
        flush()
        out.push({ k: 'n', t: mb[i] })
        i++
        j++
      } else if (j >= ma.length || (i < mb.length && dp[(i + 1) * w + j] >= dp[i * w + j + 1])) {
        dels.push({ k: 'd', t: mb[i++] })
      } else {
        adds.push({ k: 'a', t: ma[j++] })
      }
    }
    flush()
  }
  for (const t of b.slice(b.length - suf)) out.push({ k: 'n', t })
  return out
}

/** Номера строк от 1 (для сравнения целых файлов). */
function numbered(rows: DiffRow[]): DiffRow[] {
  let o = 1
  let n = 1
  return rows.map((r) => (r.k === 'a' ? { ...r, n: n++ } : r.k === 'd' ? { ...r, o: o++ } : { ...r, o: o++, n: n++ }))
}

type Seq = DiffRow | { gap: number | null }
const isGap = (x: Seq): x is { gap: number | null } => 'gap' in x

/** Все строки вида по порядку; места, где строки неизвестны, — { gap }. */
function sequence(d: FileDiff): Seq[] {
  if (d.created) return numbered(splitLines(d.after).map((t) => ({ k: 'a', t })))
  if (d.hunks && d.hunks.length > 0) {
    const orig = d.original !== undefined ? splitLines(d.original) : null
    const out: Seq[] = []
    let o = 1 // следующая строка старого файла
    let delta = 0 // newLine - oldLine вне кусков
    for (const h of d.hunks) {
      const start = Math.max(h.oldStart, 1)
      // Write/Edit пустого файла: oldStart = 0 — ничего перед куском.
      if (start > o) {
        if (orig) for (; o < start; o++) out.push({ k: 'n', o, n: o + delta, t: orig[o - 1] ?? '' })
        else out.push({ gap: start - o })
      }
      o = start
      let n = h.newStart > 0 ? h.newStart : 1
      for (const l of h.lines) {
        const c = l[0]
        const t = l.slice(1)
        if (c === '+') out.push({ k: 'a', n: n++, t })
        else if (c === '-') out.push({ k: 'd', o: o++, t })
        else if (c === ' ') out.push({ k: 'n', o: o++, n: n++, t })
        // '\ No newline at end of file' и прочее — пропускаем.
      }
      delta = n - o
    }
    if (orig) for (; o <= orig.length; o++) out.push({ k: 'n', o, n: o + delta, t: orig[o - 1] })
    return out
  }
  if (d.parts && d.parts.length > 1) {
    const out: Seq[] = []
    d.parts.forEach((p, i) => {
      if (i > 0) out.push({ gap: null })
      out.push(...lineDiff(p.before, p.after))
    })
    return out
  }
  const rows = lineDiff(d.before, d.after)
  return d.before === '' ? numbered(rows) : rows
}

/**
 * Весь текст файла после правки, если он известен: новый файл, Write (content — файл целиком)
 * или правка с исходным файлом и кусками. Неизвестен (фрагмент Edit, урезанное при сохранении) — undefined.
 */
export function fullAfter(d: FileDiff): string | undefined {
  if (d.created) return d.after || undefined
  if (d.hunks && d.hunks.length > 0) {
    if (d.original !== undefined) {
      const rows = sequence(d).filter((x): x is DiffRow => !isGap(x) && x.k !== 'd')
      return rows.map((r) => r.t).join('\n')
    }
    // Write поверх файла: content — файл целиком (после boundDiff after пуст).
    return d.before === '' && d.after !== '' && !d.truncated ? d.after : undefined
  }
  if (d.parts) return undefined
  return d.before === '' && d.after !== '' ? d.after : undefined
}

/**
 * Вид для показа: изменённые строки с CONTEXT строками вокруг, остальное — свёрнутыми кусками.
 * Кусок из одной строки не сворачивается (строка «… 1 строка» не короче самой строки).
 */
export function diffParts(d: FileDiff, context = CONTEXT): DiffPart[] {
  const seq = sequence(d)
  const out: DiffPart[] = []
  let i = 0
  while (i < seq.length) {
    const x = seq[i]
    if (isGap(x)) {
      out.push({ kind: 'gap', count: x.gap, rows: null })
      i++
      continue
    }
    if (x.k !== 'n') {
      out.push({ kind: 'row', row: x })
      i++
      continue
    }
    let j = i
    while (j < seq.length && !isGap(seq[j]) && (seq[j] as DiffRow).k === 'n') j++
    const run = seq.slice(i, j) as DiffRow[]
    // Контекст нужен только рядом с изменениями (не рядом с краем вида или неизвестным куском).
    const changedBefore = i > 0 && !isGap(seq[i - 1])
    const changedAfter = j < seq.length && !isGap(seq[j])
    const head = changedBefore ? context : 0
    const tail = changedAfter ? context : 0
    if (run.length - head - tail >= 2) {
      run.slice(0, head).forEach((row) => out.push({ kind: 'row', row }))
      const hidden = run.slice(head, run.length - tail)
      out.push({ kind: 'gap', count: hidden.length, rows: hidden })
      run.slice(run.length - tail).forEach((row) => out.push({ kind: 'row', row }))
    } else {
      run.forEach((row) => out.push({ kind: 'row', row }))
    }
    i = j
  }
  return out
}

/** Строк добавлено / удалено. */
export function diffStat(d: FileDiff): { add: number; del: number } {
  if (d.stat) return d.stat
  let add = 0
  let del = 0
  for (const x of sequence(d)) {
    if (isGap(x)) continue
    if (x.k === 'a') add++
    else if (x.k === 'd') del++
  }
  return { add, del }
}

/** Строка, на которой открыть файл в редакторе: первая изменённая в новом файле. */
export function firstChangedLine(d: FileDiff): number | undefined {
  for (const x of sequence(d)) {
    if (isGap(x) || x.k === 'n') continue
    if (x.n !== undefined) return x.n
    if (x.o !== undefined) return Math.max(1, x.o)
  }
  return undefined
}

/** structuredPatch из результата инструмента → куски; мусор — null. */
export function parseHunks(v: unknown): Hunk[] | null {
  if (!Array.isArray(v)) return null
  const out: Hunk[] = []
  for (const h of v) {
    if (!h || typeof h !== 'object') return null
    const r = h as Record<string, unknown>
    if (typeof r.oldStart !== 'number' || typeof r.newStart !== 'number' || !Array.isArray(r.lines)) return null
    out.push({ oldStart: r.oldStart, newStart: r.newStart, lines: r.lines.filter((l): l is string => typeof l === 'string') })
  }
  return out
}

/** Сколько строк вида и символов текста правки сохраняется в файле сессии. */
export const PERSIST_LINES = 80
export const PERSIST_CHARS = 64 * 1024

/**
 * Правка для файла сессии: без исходного файла, текст — не больше PERSIST_LINES строк и
 * PERSIST_CHARS символов (Write большого файла не раздувает session.json). Урезанное помечается
 * truncated, счётчики «+A −D» — от полного изменения.
 */
export function boundDiff(d: FileDiff, maxLines = PERSIST_LINES, maxChars = PERSIST_CHARS): FileDiff {
  const { original: _original, ...rest } = d
  let lines = maxLines
  let chars = maxChars
  let cut = false
  const take = (s: string): string => {
    if (s === '') return ''
    const all = s.split('\n')
    const out: string[] = []
    for (const l of all) {
      if (lines <= 0 || chars <= 0) break
      const t = l.length > chars ? l.slice(0, chars) : l
      out.push(t)
      lines--
      chars -= t.length + 1
      if (t !== l) break
    }
    const r = out.join('\n')
    if (r.length < s.replace(/\n$/, '').length) cut = true
    return r
  }
  let next: FileDiff
  if (rest.hunks && rest.hunks.length > 0) {
    // Вид строится из кусков: before/after не нужны.
    const hunks: Hunk[] = []
    for (const h of rest.hunks) {
      if (lines <= 0 || chars <= 0) {
        cut = true
        break
      }
      const kept = take(h.lines.join('\n'))
      hunks.push({ ...h, lines: kept === '' ? [] : kept.split('\n') })
    }
    next = { ...rest, before: '', after: '', hunks }
  } else if (rest.parts) {
    const parts: { before: string; after: string }[] = []
    for (const p of rest.parts) parts.push({ before: take(p.before), after: take(p.after) })
    next = { ...rest, before: '', after: '', parts }
  } else {
    // Удалённые и добавленные строки идут в виде подряд: бюджет делится между ними по порядку.
    next = { ...rest, before: take(rest.before), after: take(rest.after) }
  }
  return cut ? { ...next, truncated: true, stat: diffStat(d) } : next
}
