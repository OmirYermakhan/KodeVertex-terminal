// Подсветка окна кода в просмотре (hljs через lowlight): строки → куски с классами hljs-*,
// чтобы номер строки стоял перед каждой (макет 06, сцена Б). Цвета — .hljs-* из темы.
import { common, createLowlight } from 'lowlight'
import { extOf } from '../classify'

/**
 * Один экземпляр на приложение — и для просмотра, и для ответов Claude (rehypeHljs ниже): языки
 * регистрируются и грамматики компилируются один раз. rehype-highlight создавал свой lowlight
 * (37 языков заново) на каждый рендер блока markdown — то есть на каждый токен ответа.
 */
const lowlight = createLowlight(common)
const ALIAS: Record<string, string> = { htm: 'xml', vue: 'xml', svelte: 'xml', dart: 'dart', mdx: 'markdown', jsonc: 'json' }

export function languageOf(name: string): string | null {
  const e = extOf(name)
  if (!e) return null
  const lang = ALIAS[e] ?? e
  return lowlight.registered(lang) ? lang : null
}

export interface Piece {
  text: string
  cls?: string
}

type HNode = { type: string; value?: string; properties?: { className?: unknown }; children?: HNode[] }

/** Языки, среди которых угадывается язык кода без имени файла (diff в ответе Claude). */
const GUESS = ['kotlin', 'java', 'swift', 'typescript', 'javascript', 'python', 'rust', 'go', 'xml', 'json', 'css', 'bash', 'sql', 'yaml', 'cpp', 'csharp', 'ruby', 'php']

/** Язык кода по содержимому; не уверен — null. */
export function guessLanguage(code: string): string | null {
  if (!code.trim()) return null
  try {
    const r = lowlight.highlightAuto(code, { subset: GUESS })
    return r.data?.language && (r.data.relevance ?? 0) >= 5 ? r.data.language : null
  } catch {
    return null
  }
}

/** Строки кода с подсветкой; язык неизвестен или ошибка — строки без классов. */
export function highlightLines(lines: string[], name: string): Piece[][] {
  return highlightLinesIn(lines, languageOf(name))
}

/** Строки кода с подсветкой языком lang (имя hljs); null или ошибка — строки без классов. */
export function highlightLinesIn(lines: string[], lang: string | null): Piece[][] {
  if (!lang || !lowlight.registered(lang)) return lines.map((l) => (l ? [{ text: l }] : []))
  let tree: HNode
  try {
    tree = lowlight.highlight(lang, lines.join('\n')) as unknown as HNode
  } catch {
    return lines.map((l) => (l ? [{ text: l }] : []))
  }
  const out: Piece[][] = [[]]
  const walk = (n: HNode, cls: string | undefined) => {
    if (n.type === 'text') {
      const parts = (n.value ?? '').split('\n')
      parts.forEach((p, i) => {
        if (i > 0) out.push([])
        if (p) out[out.length - 1].push(cls ? { text: p, cls } : { text: p })
      })
      return
    }
    const own = Array.isArray(n.properties?.className) ? (n.properties!.className as string[]).join(' ') : undefined
    // Вложенный класс уточняет внешний (hljs-title внутри hljs-function).
    for (const c of n.children ?? []) walk(c, own ?? cls)
  }
  walk(tree, undefined)
  while (out.length < lines.length) out.push([])
  return out.slice(0, lines.length)
}

type HElement = { type: string; tagName?: string; properties?: Record<string, unknown>; children?: HElement[]; value?: string }

/** Язык блока по классам code (`language-x`/`lang-x`); false — `no-highlight`. Как в rehype-highlight. */
function codeLanguage(node: HElement): string | false | undefined {
  const list = node.properties?.className
  if (!Array.isArray(list)) return undefined
  let name: string | undefined
  for (const v of list) {
    const value = String(v)
    if (value === 'no-highlight' || value === 'nohighlight') return false
    if (!name && value.slice(0, 5) === 'lang-') name = value.slice(5)
    if (!name && value.slice(0, 9) === 'language-') name = value.slice(9)
  }
  return name
}

const textOf = (n: HElement): string => (n.type === 'text' ? (n.value ?? '') : (n.children ?? []).map(textOf).join(''))

/**
 * rehype-плагин: подсветка `pre > code.language-x` общим lowlight — то же, что rehype-highlight
 * с настройками по умолчанию (без угадывания языка; неизвестный язык — блок как есть).
 */
export function rehypeHljs() {
  return transform
}

function transform(tree: HElement): void {
  const visit = (node: HElement, parent: HElement | null) => {
    if (node.type === 'element' && node.tagName === 'code' && parent?.type === 'element' && parent.tagName === 'pre') {
      highlightCode(node)
      return
    }
    for (const c of node.children ?? []) visit(c, node)
  }
  visit(tree, null)
}

function highlightCode(node: HElement): void {
  const lang = codeLanguage(node)
  if (!lang) return
  const props = (node.properties ??= {})
  if (!Array.isArray(props.className)) props.className = []
  const cls = props.className as unknown[]
  if (!cls.includes('hljs')) cls.unshift('hljs')
  if (!lowlight.registered(lang)) return
  const result = lowlight.highlight(lang, textOf(node)) as unknown as HElement
  if (result.children && result.children.length > 0) node.children = result.children
}
