/** Ключевые слова CSS, которые нельзя брать в кавычки (иначе это имя семейства). */
const GENERIC = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'math',
  'emoji',
  'fangsong',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
])

/** Одно имя семейства для CSS `font-family`: ключевые слова как есть, остальное в кавычках. */
export function cssFamily(name: string): string {
  const n = name.trim()
  if (GENERIC.has(n.toLowerCase())) return n.toLowerCase()
  return `'${n.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

/** Список семейств для CSS `font-family` без повторов. */
export function fontStack(...names: string[]): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const n of names) {
    const f = cssFamily(n)
    if (n.trim() === '' || seen.has(f)) continue
    seen.add(f)
    out.push(f)
  }
  return out.join(', ')
}

export const textFontStack = (font: string): string => fontStack(font, 'sans-serif')

/** Для `ui-monospace` (SF Mono) ближайшая замена — Menlo; затем встроенный JetBrains Mono. */
export const codeFontStack = (font: string): string =>
  fontStack(font, ...(font.trim() === 'ui-monospace' ? ['Menlo'] : []), 'JetBrains Mono', 'monospace')
