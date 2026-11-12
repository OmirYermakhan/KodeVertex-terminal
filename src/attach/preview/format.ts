// Подписи мини-просмотра (макет 06, галерея В): «6 KB», «182 строки», «312 слов», «7 файлов», «14:31».

/** Русское число: 1 строка, 2 строки, 5 строк. */
export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10
  const m100 = n % 100
  const w = m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many
  return `${n} ${w}`
}

export const linesLabel = (n: number) => plural(n, 'строка', 'строки', 'строк')
export const wordsLabel = (n: number) => plural(n, 'слово', 'слова', 'слов')
export const filesLabel = (n: number) => plural(n, 'файл', 'файла', 'файлов')

/** Размер как в макете: «412 KB», «1.2 MB». */
export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** Число и единица отдельно — в подвале число выделено (`<b>6</b> KB`). */
export function sizeParts(bytes: number): [string, string] {
  const s = sizeLabel(bytes)
  const i = s.lastIndexOf(' ')
  return [s.slice(0, i), s.slice(i + 1)]
}

export function clock(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length
}

/** Markdown → простой текст для просмотра сообщения: без блоков кода и разметки; `код` остаётся. */
export function plainMessage(md: string): string {
  return md
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/\*\*|__|(?<!\w)[*_](?!\s)|(?<!\s)[*_](?!\w)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
}
