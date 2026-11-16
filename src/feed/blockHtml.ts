// HTML замороженного блока — только из SerializeAddon.serializeAsHTML. Форма вывода аддона:
// <html><body><!--StartFragment--><pre><div style='color; background; font-family; font-size'>
//   <div><span>…строка…</span></div> × N
// </div></pre><!--EndFragment--></body></html>
// Текст внутри строк экранирован аддоном (& и <), поэтому '</span></div>' встречается только на концах строк.

const ROW = /<div><span>[\s\S]*?<\/span><\/div>/g

/** Строки вывода (каждая — '<div><span>…</span></div>'). */
export function serializedRows(html: string): string[] {
  return html.match(ROW) ?? []
}

/** Убирает обёртку аддона (чёрный цвет, белый фон, шрифт xterm) — остаются только строки. */
export function cleanSerializedHtml(raw: string): string {
  return serializedRows(raw).join('')
}

const textCache = new WeakMap<object, string>()

/**
 * Текст замороженного блока (объект блока не меняется — кэш по нему): разбор HTML один раз
 * на блок для ⌘L, перетаскивания и поиска `@`.
 */
export function blockTextOf(b: { html: string | null }): string {
  let s = textCache.get(b)
  if (s === undefined) {
    s = b.html ? blockText(b.html) : ''
    textCache.set(b, s)
  }
  return s
}

/** Текст блока для копирования: строки без хвостовых пробелов. */
export function blockText(html: string): string {
  const tpl = document.createElement('template')
  tpl.innerHTML = html
  const rows = Array.from(tpl.content.children, (el) => (el.textContent ?? '').replace(/\s+$/, ''))
  while (rows.length && rows[rows.length - 1] === '') rows.pop()
  return rows.join('\n')
}

/** Свойства, которые SerializeAddon пишет в style ячейки (_diffStyle), и их значения. */
const STYLE_PROP = '(?:color|background-color|font-weight|text-decoration|visibility|font-style|opacity)'
const STYLE_VALUE = '(?:#[0-9a-fA-F]{3,8}|rgba?\\([\\d., %]+\\)|[a-z-]+(?: [a-z-]+)*|[\\d.]+)'
/**
 * Токены HTML блока: теги строк и ячеек аддона, текст без `<` и `&` (аддон экранирует их)
 * и сущности. Разбор — линейным проходом (sticky), без возвратов по мегабайтам вывода.
 */
const TOKEN = new RegExp(
  `<div>|</div>|<span>|</span>|<span style='(?:${STYLE_PROP}: ${STYLE_VALUE}; ?)+'>|[^<&]+|&(?:amp|lt|gt|quot|#\\d{1,7});`,
  'y',
)

/**
 * HTML блока — ровно той формы, что отдаёт SerializeAddon (после cleanSerializedHtml)? Блоки
 * восстанавливаются из session.json на диске: подправленный файл не должен попасть в DOM
 * тегами и атрибутами (<img onerror>, <a href>…). Иное — показывается текстом.
 */
export function isSerializedHtml(html: string): boolean {
  TOKEN.lastIndex = 0
  while (TOKEN.lastIndex < html.length) {
    const at = TOKEN.lastIndex
    if (!TOKEN.test(html) || TOKEN.lastIndex === at) return false
  }
  return true
}
