import { describe, expect, it } from 'vitest'
import { codeFontStack, cssFamily, fontStack, textFontStack } from './fontFamily'

describe('fontFamily', () => {
  it('leaves generic keywords unquoted', () => {
    for (const g of ['system-ui', 'ui-monospace', 'monospace', 'sans-serif', 'serif']) expect(cssFamily(g)).toBe(g)
  })
  it('quotes names and escapes quotes and backslashes', () => {
    expect(cssFamily('JetBrains Mono')).toBe("'JetBrains Mono'")
    expect(cssFamily("O'Font")).toBe("'O\\'Font'")
    expect(cssFamily('a\\b')).toBe("'a\\\\b'")
  })
  it('builds a stack without duplicates', () => {
    expect(fontStack('JetBrains Mono', 'JetBrains Mono', 'monospace')).toBe("'JetBrains Mono', monospace")
  })
  it('text and code stacks', () => {
    expect(textFontStack('Inter')).toBe("'Inter', sans-serif")
    expect(textFontStack('system-ui')).toBe('system-ui, sans-serif')
    expect(codeFontStack('Fira Code')).toBe("'Fira Code', 'JetBrains Mono', monospace")
    expect(codeFontStack('ui-monospace')).toBe("ui-monospace, 'Menlo', 'JetBrains Mono', monospace")
  })
})
