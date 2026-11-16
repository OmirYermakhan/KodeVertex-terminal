import { SerializeAddon } from '@xterm/addon-serialize'
import { Terminal } from '@xterm/xterm'
import { describe, expect, it } from 'vitest'
import { blockText, cleanSerializedHtml, isSerializedHtml, serializedRows } from './blockHtml'

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

describe('isSerializedHtml', () => {
  it('настоящий вывод аддона (цвета, жирный, подчёркивание, инверсия, & и <) — допустим', async () => {
    const raw = await serialize('\x1b[1;31ma<b>&c\x1b[0m \x1b[4;38;2;1;2;3mx\x1b[7m y\x1b[2;3;9mz\r\n\x1b[44mq', 2)
    const html = cleanSerializedHtml(raw)
    expect(html).toContain("<span style='")
    expect(isSerializedHtml(html)).toBe(true)
    expect(isSerializedHtml('')).toBe(true)
  })

  it('чужие теги, атрибуты и подправленный style — нет', () => {
    for (const bad of [
      '<div><span><img src=x onerror=alert(1)></span></div>',
      "<div><span style='color: red' onclick='x'>a</span></div>",
      "<div><span style='background-image: url(x);'>a</span></div>",
      '<div><a href="javascript:x">a</a></div>',
      '<div><span>a &foo; b</span></div>',
      '<script>alert(1)</script>',
    ]) {
      expect(isSerializedHtml(bad)).toBe(false)
    }
  })
})
