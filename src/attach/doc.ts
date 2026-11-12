// Модель строки ввода со значками: чистые функции над Doc (входные данные не мутируются).
// Позиции — индексы UTF-16 в doc.text; значок занимает ровно один символ (TOKEN_CHAR).
import { TOKEN_CHAR, type Attachment, type Doc } from './types'

export interface Sel {
  start: number
  end: number
}

/** Результат правки: новый текст, курсор и выбранный (первым ⌫) значок. */
export interface Edit {
  doc: Doc
  caret: number
  /** id значка, выбранного первым ⌫/⌦ (вид `.tk.sel`); null — ничего не выбрано. */
  selected: string | null
}

export const isToken = (ch: string | undefined) => ch === TOKEN_CHAR

export function countTokens(text: string, end = text.length): number {
  let n = 0
  for (let i = 0; i < end; i++) if (text.charCodeAt(i) === 0xfffc) n++
  return n
}

/** Значок в позиции pos (text[pos] — TOKEN_CHAR) или null. */
export function tokenAt(doc: Doc, pos: number): Attachment | null {
  if (!isToken(doc.text[pos])) return null
  return doc.tokens[countTokens(doc.text, pos)] ?? null
}

/** Позиция значка id в тексте; -1 — нет. */
export function tokenPos(doc: Doc, id: string): number {
  const i = doc.tokens.findIndex((t) => t.id === id)
  if (i < 0) return -1
  let n = -1
  for (let p = 0; p < doc.text.length; p++) {
    if (isToken(doc.text[p]) && ++n === i) return p
  }
  return -1
}

/** Управляющие символы, кроме \t и \n, и заместитель значка — из вставляемого текста. */
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\x00-\x08\x0b-\x1f\x7f-\x9f￼​]/g

export function sanitizeText(s: string): string {
  return s.replace(/\r\n?/g, '\n').replace(UNSAFE, '')
}

/**
 * Заменить [start, end) на ins. TOKEN_CHAR в ins — значки из insTokens по порядку
 * (их число должно совпадать). Значки внутри удалённого диапазона пропадают.
 */
export function splice(doc: Doc, start: number, end: number, ins: string, insTokens: Attachment[] = []): { doc: Doc; caret: number } {
  const a = Math.max(0, Math.min(start, end, doc.text.length))
  const b = Math.min(doc.text.length, Math.max(start, end))
  const before = countTokens(doc.text, a)
  const removed = countTokens(doc.text.slice(a, b))
  const tokens = [...doc.tokens.slice(0, before), ...insTokens, ...doc.tokens.slice(before + removed)]
  return { doc: { text: doc.text.slice(0, a) + ins + doc.text.slice(b), tokens }, caret: a + ins.length }
}

export function insertText(doc: Doc, sel: Sel, s: string): Edit {
  const r = splice(doc, sel.start, sel.end, sanitizeText(s))
  return { ...r, selected: null }
}

/**
 * Вставить значки у курсора (заменяя выделение). Между значками — пробел; перед ними пробел,
 * если курсор стоит сразу после буквы (а не после пробела, перевода строки или начала).
 */
export function insertTokens(doc: Doc, sel: Sel, toks: Attachment[]): Edit {
  if (toks.length === 0) return { doc, caret: sel.end, selected: null }
  const a = Math.min(sel.start, sel.end)
  const prev = doc.text[a - 1]
  const lead = prev !== undefined && !/\s/.test(prev) ? ' ' : ''
  const ins = lead + toks.map(() => TOKEN_CHAR).join(' ')
  const r = splice(doc, sel.start, sel.end, ins, toks)
  return { ...r, selected: null }
}

const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null

/** Граница соседнего графемного кластера (буква с диакритикой, эмодзи — целиком). */
export function step(text: string, pos: number, dir: -1 | 1): number {
  if (dir < 0 && pos <= 0) return 0
  if (dir > 0 && pos >= text.length) return text.length
  if (segmenter) {
    let prev = 0
    for (const s of segmenter.segment(text)) {
      const end = s.index + s.segment.length
      if (dir > 0 && end > pos) return end
      if (dir < 0 && end >= pos) return s.index < pos ? s.index : prev
      prev = s.index
    }
    return dir > 0 ? text.length : prev
  }
  // Без Intl.Segmenter — по code point.
  if (dir < 0) {
    const c = text.charCodeAt(pos - 1)
    return pos - (c >= 0xdc00 && c <= 0xdfff && pos >= 2 ? 2 : 1)
  }
  const c = text.charCodeAt(pos)
  return pos + (c >= 0xd800 && c <= 0xdbff && pos + 1 < text.length ? 2 : 1)
}

/**
 * ⌫. Выделение — удалить его. Слева значок: первое нажатие его выделяет, второе удаляет —
 * так случайно ничего не сотрётся. Иначе — одна буква.
 */
export function backspace(doc: Doc, sel: Sel, selected: string | null): Edit {
  if (sel.start !== sel.end) return { ...splice(doc, sel.start, sel.end, ''), selected: null }
  const pos = sel.start
  if (pos <= 0) return { doc, caret: 0, selected: null }
  const tok = tokenAt(doc, pos - 1)
  if (tok) {
    if (selected === tok.id) return { ...splice(doc, pos - 1, pos, ''), selected: null }
    return { doc, caret: pos, selected: tok.id }
  }
  return { ...splice(doc, step(doc.text, pos, -1), pos, ''), selected: null }
}

/** ⌦ — то же, что ⌫, вправо от курсора. */
export function forwardDelete(doc: Doc, sel: Sel, selected: string | null): Edit {
  if (sel.start !== sel.end) return { ...splice(doc, sel.start, sel.end, ''), selected: null }
  const pos = sel.start
  if (pos >= doc.text.length) return { doc, caret: pos, selected: null }
  const tok = tokenAt(doc, pos)
  if (tok) {
    if (selected === tok.id) return { ...splice(doc, pos, pos + 1, ''), selected: null }
    return { doc, caret: pos, selected: tok.id }
  }
  const r = splice(doc, pos, step(doc.text, pos, 1), '')
  return { doc: r.doc, caret: pos, selected: null }
}

/** ←/→: значок — как одна буква; буквы — по графемам. */
export function moveCaret(text: string, pos: number, dir: -1 | 1): number {
  return step(text, pos, dir)
}

/** Значок при копировании: путь для файлов и папок, иначе подпись в скобках. */
export function readableToken(t: Attachment): string {
  if ((t.kind === 'file' || t.kind === 'folder' || t.kind === 'pdf' || t.kind === 'image') && t.path) {
    return t.path + (t.line ? `:${t.line}` : '')
  }
  return `[${t.label}]`
}

/** Текст [start, end) для буфера обмена: значки — читаемым видом. */
export function readable(doc: Doc, start = 0, end = doc.text.length): string {
  let out = ''
  let ti = countTokens(doc.text, start)
  for (let i = start; i < end; i++) {
    const ch = doc.text[i]
    if (isToken(ch)) {
      const t = doc.tokens[ti++]
      out += t ? readableToken(t) : ''
    } else out += ch
  }
  return out
}

export type Segment = { type: 'text'; text: string } | { type: 'token'; token: Attachment }

/** Текст и значки по порядку (пустые текстовые куски не попадают). */
export function segments(doc: Doc): Segment[] {
  const out: Segment[] = []
  let ti = 0
  let run = ''
  for (const ch of doc.text) {
    if (isToken(ch)) {
      if (run) out.push({ type: 'text', text: run })
      run = ''
      const t = doc.tokens[ti++]
      if (t) out.push({ type: 'token', token: t })
    } else run += ch
  }
  if (run) out.push({ type: 'text', text: run })
  return out
}

/** Текст без значков приводится к Doc; значки берутся из tokens, если их число совпадает. */
export function docOf(text: string, tokens: Attachment[] = []): Doc {
  const n = countTokens(text)
  if (n === tokens.length) return { text, tokens }
  return { text: text.replaceAll(TOKEN_CHAR, ''), tokens: [] }
}

export const hasTokens = (doc: Doc) => doc.tokens.length > 0
