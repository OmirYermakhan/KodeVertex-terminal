import { SerializeAddon } from '@xterm/addon-serialize'
import { Terminal } from '@xterm/xterm'
import { describe, expect, it } from 'vitest'
import { blockText, cleanSerializedHtml, serializedRows } from './blockHtml'

const write = (t: Terminal, s: string) => new Promise<void>((r) => t.write(s, r))

// Настоящий xterm + SerializeAddon: проверяем форму, которую реально отдаёт аддон.
async function serialize(data: string, lines: number) {
  const t = new Terminal({ cols: 20, rows: 5, allowProposedApi: true })
  const s = new SerializeAddon()
  t.loadAddon(s)
  await write(t, data)
  const html = s.serializeAsHTML({ includeGlobalBackground: false, range: { startLine: 0, endLine: lines - 1, startCol: 0 } })
  t.dispose()
  return html
}

describe('cleanSerializedHtml', () => {
  it('снимает внешнюю обёртку аддона со шрифтом и фоном, оставляет строки', async () => {
    const raw = await serialize('\x1b[31mred\x1b[0m <b>&\r\nline2 is very long and wraps\r\n', 3)
    expect(raw).toContain('background-color: #ffffff')
    const html = cleanSerializedHtml(raw)
    expect(html).not.toMatch(/<html|<pre|font-family|background-color: #ffffff|color: #000000/)
    const rows = serializedRows(html)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toContain("<span style='color: #cc0000;'>red</span>")
    expect(rows[0]).toContain('&lt;b>&amp;')
    expect(blockText(html)).toBe('red <b>&\nline2 is very long a\nnd wraps')
  })
  it('пустой или чужой ввод → пустая строка', () => {
    expect(cleanSerializedHtml('')).toBe('')
    expect(cleanSerializedHtml('<script>alert(1)</script>')).toBe('')
  })
})

describe('serializedRows', () => {
  it('по строке на <div>', () => {
    expect(serializedRows('<div><span>a</span></div><div><span></span><span>b</span></div>')).toEqual([
      '<div><span>a</span></div>',
      '<div><span></span><span>b</span></div>',
    ])
  })
})
