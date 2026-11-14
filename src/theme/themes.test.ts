import { describe, expect, it } from 'vitest'
import { THEMES, ansiFromTokens, type ThemeId } from './themes'

const ids = ['kv', 'warm', 'cold', 'light', 'as'] as ThemeId[]

describe('themes', () => {
  it('every theme has all tokens as hex colors', () => {
    const keys = Object.keys(THEMES.as.tokens)
    expect(keys).toHaveLength(69)
    for (const id of ids) {
      expect(Object.keys(THEMES[id].tokens).sort()).toEqual([...keys].sort())
      for (const v of Object.values(THEMES[id].tokens)) expect(v).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })
  it('as theme matches Android Studio', () => {
    expect(THEMES.as.tokens).toMatchObject({ bg: '#1e1f22', panel: '#2b2d30', text: '#bcbec4', acc: '#3574f0' })
  })
  it('цвета git как в макете 07 (тема AS); удалённый — приглушённый', () => {
    expect(THEMES.as.tokens).toMatchObject({ vcsMod: '#6c9fef', vcsAdd: '#73bd79', vcsNew: '#d1675a', vcsDel: '#6f737a', hover: '#2f3136', sbIcon: '#a8adb5', sel: '#2e436e', selDim: '#2a3346' })
    for (const id of ids) expect(THEMES[id].tokens.vcsDel).toBe(THEMES[id].tokens.muted)
  })
  it('поля кода в просмотре файла как в макете 07 (тема AS)', () => {
    expect(THEMES.as.tokens).toMatchObject({ edLn: '#4b5059', edCur: '#26282e', edCurLn: '#a1a3ab' })
  })
  it('метки веток в логе как в макете 07 (тема AS)', () => {
    expect(THEMES.as.tokens).toMatchObject({ refRule: '#4a6a3f', refText: '#8fbf7f', headRule: '#3e5c8f', headText: '#86a9ea' })
  })
  it('значки папки и проекта как в макете 07 (тема AS), в светлой теме — свои; в CSS — только токены', async () => {
    const fs = (await import(/* @vite-ignore */ 'node:' + 'fs')) as { readFileSync(p: string, e: string): string }
    const css = fs.readFileSync('src/global.css', 'utf8')
    expect(THEMES.as.tokens).toMatchObject({ fold: '#87939a', projIcon: '#3e8f5a' })
    expect(THEMES.light.tokens.fold).not.toBe(THEMES.as.tokens.fold)
    expect(css).not.toMatch(/#87939a|#3e8f5a/i)
    expect(css).toMatch(/\.fold \{[^}]*background: var\(--fold\)/)
    expect(css).toMatch(/\.proj \.pi \{[^}]*background: var\(--projIcon\)/)
  })
  it('only light is not dark', () => {
    expect(THEMES.light.dark).toBe(false)
    for (const id of ids.filter((i) => i !== 'light')) expect(THEMES[id].dark).toBe(true)
  })
  it('ansiFromTokens maps black/white for dark themes', () => {
    for (const id of ids.filter((i) => THEMES[i].dark)) {
      const t = THEMES[id].tokens
      expect(ansiFromTokens(t, true)).toMatchObject({ white: t.text, black: t.panel, brightBlack: t.muted, brightWhite: t.strong })
    }
  })
  it('ansiFromTokens swaps black/white on the light theme', () => {
    const t = THEMES.light.tokens
    expect(ansiFromTokens(t, THEMES.light.dark)).toMatchObject({
      black: t.strong, brightBlack: t.muted, white: t.panel, brightWhite: t.bg,
    })
  })
  it('ansiFromTokens maps colour tokens', () => {
    for (const id of ids) {
      const t = THEMES[id].tokens
      const a = ansiFromTokens(t, THEMES[id].dark)
      expect(a).toMatchObject({
        red: t.del, green: t.add, yellow: t.warn, blue: t.info, magenta: t.mag, cyan: t.num,
        brightRed: t.del, brightGreen: t.add, brightYellow: t.warn, brightBlue: t.info,
        brightMagenta: t.mag, brightCyan: t.num,
        background: t.bg, foreground: t.text, cursor: t.accText, selectionBackground: t.acc + '55',
      })
    }
  })
  it('as keeps the mockup colours of Fable and the «Вы» label', () => {
    expect(THEMES.as.tokens).toMatchObject({ gold: '#e8c46a', goldRule: '#5a4a22', youWho: '#9fb6e8' })
  })
})

// Контраст WCAG 2: (L1 + 0.05) / (L2 + 0.05).
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

describe('theme contrast', () => {
  it('contrast() follows WCAG', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21)
    expect(contrast('#777777', '#777777')).toBeCloseTo(1)
  })
  // Пары «текст — фон», на которых проверка тем нашла провалы; текст мелкий — порог 4.5.
  it.each(ids)('%s: Fable gold, «Вы» label and warnings are readable', (id) => {
    const t = THEMES[id].tokens
    for (const bg of [t.bg, t.panel, t.panel2]) {
      expect(contrast(t.gold, bg)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(t.warn, bg)).toBeGreaterThanOrEqual(4.5)
    }
    expect(contrast(t.youWho, t.you)).toBeGreaterThanOrEqual(4.5)
  })
  // Плашка «◆ CLAUDE» (--acc) и «bypass» (--del) в статус-баре: текст --onAcc, жирный — порог 3.
  it.each(ids)('%s: text on accent and danger pills is readable', (id) => {
    const t = THEMES[id].tokens
    expect(contrast(t.onAcc, t.acc)).toBeGreaterThanOrEqual(3)
    expect(contrast(t.onAcc, t.del)).toBeGreaterThanOrEqual(3)
  })
  // Неизменённые строки диффа и комментарии в коде (--com) — не тусклее 3:1 к фону.
  it.each(ids)('%s: comments and diff context stay legible', (id) => {
    const t = THEMES[id].tokens
    expect(contrast(t.com, t.bg)).toBeGreaterThanOrEqual(3)
  })
})
