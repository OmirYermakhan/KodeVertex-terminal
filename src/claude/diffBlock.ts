// Блок ```diff в ответе Claude — как в Android Studio: у строк +/− тонированный фон и цветной знак,
// а сам код подсвечен по языку файла (не весь зелёным/красным). Язык — по имени файла из заголовков
// diff (`+++ b/…`, `diff --git`) или из текста перед блоком (`core/RemoteConfig.kt`), иначе угадывается.
import { guessLanguage, highlightLinesIn, languageOf } from '../attach/preview/highlight'

type HNode = { type: string; tagName?: string; children?: HNode[]; properties?: Record<string, unknown>; value?: string }

export type DiffKind = 'a' | 'd' | 'c' | 'h' | 'm'

export interface DiffLine {
  kind: DiffKind
  /** Знак в начале (+, −, пробел) — для a/d/c; у h/m весь текст строки — в code. */
  mark: string
  code: string
}

const META = /^(diff --git |index |--- |\+\+\+ |new file|deleted file|old mode|new mode|similarity|rename |Binary files)/

/** Строки diff по видам: добавлена, удалена, контекст, заголовок куска (@@), служебная. */
export function parseDiff(text: string): DiffLine[] {
  let inHunk = false
  return text.split('\n').map((l): DiffLine => {
    if (l.startsWith('diff --git ')) inHunk = false
    if (l.startsWith('@@')) {
      inHunk = true
      return { kind: 'h', mark: '', code: l }
    }
    if (!inHunk && META.test(l)) return { kind: 'm', mark: '', code: l }
    if (l.startsWith('\\')) return { kind: 'm', mark: '', code: l }
    if (l.startsWith('+')) return { kind: 'a', mark: '+', code: l.slice(1) }
    if (l.startsWith('-')) return { kind: 'd', mark: '-', code: l.slice(1) }
    return { kind: 'c', mark: l.startsWith(' ') ? ' ' : '', code: l.startsWith(' ') ? l.slice(1) : l }
  })
}

/** Похоже на diff без пометки языка: начинается с `diff --git` или `@@ -N`. */
export function looksLikeDiff(text: string): boolean {
  const first = text.split('\n').find((l) => l.trim()) ?? ''
  return first.startsWith('diff --git ') || /^@@ -\d/.test(first)
}

const FILE = /[\w@~.-]*(?:\/[\w@~.-]+)*\.[A-Za-z][\w]{0,9}/g

/** Последнее имя файла с известным языком в тексте. */
function langFromText(s: string): string | null {
  const names = s.match(FILE) ?? []
  for (let i = names.length - 1; i >= 0; i--) {
    const l = languageOf(names[i])
    if (l) return l
  }
  return null
}

function textOf(n: HNode): string {
  return n.type === 'text' ? (n.value ?? '') : (n.children ?? []).map(textOf).join('')
}

const span = (cls: string[], children: HNode[]): HNode => ({ type: 'element', tagName: 'span', properties: { className: cls }, children })
const txt = (value: string): HNode => ({ type: 'text', value })

/**
 * Строки diff → hast: `span.md-dl.<вид>` на строку (знак `span.md-dm` + подсвеченный код, `\n` в конце,
 * чтобы копирование давало тот же текст). Каждый файл (`diff --git`) подсвечивается своим языком.
 */
export function diffToHast(text: string, hintLang: string | null): HNode[] {
  const lines = parseDiff(text.replace(/\n$/, ''))
  // Разделы по файлам: язык из `+++ b/путь` / `diff --git`, иначе подсказка, иначе угадывается по коду.
  const sections: number[][] = []
  for (let i = 0; i < lines.length; i++) {
    if (i === 0 || lines[i].code.startsWith('diff --git ')) sections.push([])
    sections[sections.length - 1].push(i)
  }
  const out: HNode[] = []
  for (const idx of sections) {
    const header = idx.filter((i) => lines[i].kind === 'm').map((i) => lines[i].code).join('\n')
    const codeIdx = idx.filter((i) => lines[i].kind === 'a' || lines[i].kind === 'd' || lines[i].kind === 'c')
    const code = codeIdx.map((i) => lines[i].code)
    const lang = langFromText(header) ?? hintLang ?? guessLanguage(code.join('\n'))
    const lit = highlightLinesIn(code, lang)
    const pieces = new Map(codeIdx.map((i, k) => [i, lit[k]]))
    for (const i of idx) {
      const l = lines[i]
      const body = pieces.get(i)
      const kids: HNode[] = body
        ? [span(['md-dm'], [txt(l.mark)]), ...body.map((p) => (p.cls ? span(p.cls.split(' '), [txt(p.text)]) : txt(p.text)))]
        : [txt(l.code)]
      kids.push(txt('\n'))
      out.push(span(['md-dl', l.kind], kids))
    }
  }
  return out
}

function classes(n: HNode | undefined): string[] {
  const c = n?.properties?.className
  return Array.isArray(c) ? (c as string[]) : []
}

/** rehype-плагин (до rehype-highlight): блоки diff → строки с фоном и подсветкой языка файла. */
export function rehypeDiff() {
  return (tree: HNode) => {
    const walk = (parent: HNode) => {
      const kids = parent.children ?? []
      kids.forEach((n, i) => {
        if (n.type !== 'element') return
        if (n.tagName !== 'pre') return walk(n)
        const code = n.children?.find((k) => k.type === 'element' && k.tagName === 'code')
        if (!code) return
        const cls = classes(code)
        const lang = cls.find((c) => c.startsWith('language-'))
        const text = textOf(code)
        const isDiff = lang === 'language-diff' || lang === 'language-patch' || (!lang && looksLikeDiff(text))
        if (!isDiff) return
        // Подсказка языка — имя файла в ближайшем элементе перед блоком (заголовок, абзац).
        let hint: string | null = null
        for (let j = i - 1; j >= 0 && hint === null; j--) {
          const prev = kids[j]
          if (prev.type === 'element') {
            hint = langFromText(textOf(prev))
            break
          }
        }
        code.children = diffToHast(text, hint)
        code.properties = { ...code.properties, className: ['no-highlight', 'md-diff-code'] }
        n.properties = { ...n.properties, className: [...classes(n), 'md-diff'] }
      })
    }
    walk(tree)
  }
}
