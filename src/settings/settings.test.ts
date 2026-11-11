import { describe, expect, it } from 'vitest'
import { DEFAULTS, normalizeSettings, stepSize, terminalLineHeight } from './settings'
import { THEMES } from '../theme/themes'
import { applyTheme } from '../theme/applyTheme'

describe('settings', () => {
  it('defaults', () => {
    expect(DEFAULTS).toEqual({ theme: 'as', textFont: 'Inter', codeFont: 'JetBrains Mono', textSize: 16, codeSize: 14, lineHeight: 1.7, ligatures: true })
    expect(normalizeSettings(undefined)).toEqual(DEFAULTS)
    expect(normalizeSettings('мусор')).toEqual(DEFAULTS)
  })
  it('normalizes values', () => {
    expect(normalizeSettings({ theme: 'nope' }).theme).toBe('as')
    expect(normalizeSettings({ theme: 'warm' }).theme).toBe('warm')
    expect(normalizeSettings({ textSize: 400 }).textSize).toBe(28)
    expect(normalizeSettings({ textSize: 3 }).textSize).toBe(11)
    expect(normalizeSettings({ codeSize: 400 }).codeSize).toBe(24)
    expect(normalizeSettings({ codeSize: 3 }).codeSize).toBe(10)
    expect(normalizeSettings({ lineHeight: 1.65 }).lineHeight).toBe(1.7)
    expect(normalizeSettings({ textFont: '' }).textFont).toBe('Inter')
    expect(normalizeSettings({ foo: 1 })).not.toHaveProperty('foo')
  })
  it('stepSize clamps', () => {
    expect(stepSize(28, 1, 'text')).toBe(28)
    expect(stepSize(16, -1, 'text')).toBe(15)
    expect(stepSize(10, -1, 'code')).toBe(10)
  })
  it('terminalLineHeight', () => {
    expect(terminalLineHeight({ ...DEFAULTS, lineHeight: 1.7 })).toBeCloseTo(1.36, 2)
  })
  it('applyTheme writes css vars', () => {
    const el = document.createElement('div')
    applyTheme(THEMES.light, { ...DEFAULTS, ligatures: false }, el)
    expect(el.style.getPropertyValue('--bg')).toBe('#f6f5f0')
    expect(el.style.getPropertyValue('--liga')).toBe('none')
    expect(el.style.getPropertyValue('--size-text')).toBe('16px')
    expect(el.style.getPropertyValue('color-scheme')).toBe('light')
  })
})
