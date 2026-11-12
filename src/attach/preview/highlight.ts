// Подсветка окна кода в просмотре (hljs через lowlight): строки → куски с классами hljs-*,
// чтобы номер строки стоял перед каждой (макет 06, сцена Б). Цвета — .hljs-* из темы.
import { common, createLowlight } from 'lowlight'
import { extOf } from '../classify'

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

/** Строки кода с подсветкой; язык неизвестен или ошибка — строки без классов. */
export function highlightLines(lines: string[], name: string): Piece[][] {
  const lang = languageOf(name)
  if (!lang) return lines.map((l) => (l ? [{ text: l }] : []))
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
