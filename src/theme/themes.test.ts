import { describe, expect, it } from 'vitest'
import { THEMES, ansiFromTokens, type ThemeId } from './themes'

const ids = ['kv', 'warm', 'cold', 'light', 'as'] as ThemeId[]

describe('themes', () => {
  it('every theme has all tokens as hex colors', () => {
    const keys = Object.keys(THEMES.as.tokens)
    expect(keys).toHaveLength(23)
    for (const id of ids) {
      expect(Object.keys(THEMES[id].tokens).sort()).toEqual([...keys].sort())
      for (const v of Object.values(THEMES[id].tokens)) expect(v).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })
  it('as theme matches Android Studio', () => {
    expect(THEMES.as.tokens).toMatchObject({ bg: '#1e1f22', panel: '#2b2d30', text: '#bcbec4', acc: '#3574f0' })
  })
  it('only light is not dark', () => {
    expect(THEMES.light.dark).toBe(false)
    for (const id of ids.filter((i) => i !== 'light')) expect(THEMES[id].dark).toBe(true)
  })
  it('ansiFromTokens maps tokens', () => {
    for (const id of ids) {
      const t = THEMES[id].tokens
      const a = ansiFromTokens(t)
      expect(a).toMatchObject({
        red: t.del, green: t.add, yellow: t.warn, blue: t.info, magenta: t.mag, cyan: t.num,
        white: t.text, black: t.panel, brightBlack: t.muted, brightWhite: t.strong,
        brightRed: t.del, brightGreen: t.add, brightYellow: t.warn, brightBlue: t.info,
        brightMagenta: t.mag, brightCyan: t.num,
        background: t.bg, foreground: t.text, cursor: t.accText, selectionBackground: t.acc + '55',
      })
    }
  })
})
