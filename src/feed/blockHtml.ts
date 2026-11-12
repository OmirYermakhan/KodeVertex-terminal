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

/** Текст блока для копирования: строки без хвостовых пробелов. */
export function blockText(html: string): string {
  const tpl = document.createElement('template')
  tpl.innerHTML = html
  const rows = Array.from(tpl.content.children, (el) => (el.textContent ?? '').replace(/\s+$/, ''))
  while (rows.length && rows[rows.length - 1] === '') rows.pop()
  return rows.join('\n')
}
