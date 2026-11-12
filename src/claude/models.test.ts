import { describe, expect, it } from 'vitest'
import {
  EFFORTS,
  MODEL_ROWS,
  aliasOf,
  effortRequest,
  initialPicker,
  modelNote,
  pickerKey,
  setModelRequest,
} from './models'

describe('модели', () => {
  it('строки — как в /model TUI, Default первая', () => {
    expect(MODEL_ROWS.map((r) => r.label)).toEqual(['Default (рекомендуется)', 'Opus 5.5', 'Fable 5.2', 'Sonnet 5.5', 'Haiku 5.5'])
    expect(MODEL_ROWS.map((r) => r.alias)).toEqual(['default', 'opus', 'fable', 'sonnet', 'haiku'])
    expect(EFFORTS).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('aliasOf понимает псевдонимы, [1m] и полные имена', () => {
    expect(aliasOf('opus[1m]')).toBe('opus')
    expect(aliasOf('claude-fable-5-2')).toBe('fable')
    expect(aliasOf('Sonnet')).toBe('sonnet')
    expect(aliasOf('claude-haiku-5-5-20261001')).toBe('haiku')
    expect(aliasOf(null)).toBeNull()
    expect(aliasOf('gpt')).toBeNull()
  })

  it('управляющие запросы', () => {
    expect(setModelRequest('fable')).toEqual({ subtype: 'set_model', model: 'fable' })
    expect(effortRequest('high')).toEqual({ subtype: 'apply_flag_settings', settings: { effortLevel: 'high' } })
  })

  it('заметка в ленте', () => {
    expect(modelNote('claude-fable-5-2', 'high')).toBe('Модель: Fable 5.2 · усилие high')
    expect(modelNote('claude-opus-5-5', null)).toBe('Модель: Opus 5.5')
  })
})

describe('pickerKey', () => {
  const s0 = initialPicker('fable', 'medium')

  it('начинает с текущей модели и усилия', () => {
    expect(s0).toEqual({ selected: 2, effort: 1, effortTouched: false })
    expect(initialPicker(null, null)).toEqual({ selected: 0, effort: 1, effortTouched: false })
  })

  it('↑↓ по кругу, 1–5 — сразу к строке', () => {
    expect(pickerKey(s0, 'ArrowDown').state.selected).toBe(3)
    expect(pickerKey(s0, 'ArrowUp').state.selected).toBe(1)
    expect(pickerKey({ ...s0, selected: 4 }, 'ArrowDown').state.selected).toBe(0)
    expect(pickerKey({ ...s0, selected: 0 }, 'ArrowUp').state.selected).toBe(4)
    expect(pickerKey(s0, '5').state.selected).toBe(4)
    expect(pickerKey(s0, '1').state.selected).toBe(0)
    expect(pickerKey(s0, '6').handled).toBe(false)
  })

  it('←→ меняют усилие в пределах уровней', () => {
    const r = pickerKey(s0, 'ArrowRight')
    expect(r.state).toMatchObject({ effort: 2, effortTouched: true })
    expect(pickerKey({ ...s0, effort: 4 }, 'ArrowRight').state.effort).toBe(4)
    expect(pickerKey({ ...s0, effort: 0 }, 'ArrowLeft').state.effort).toBe(0)
  })

  it('↵ — по умолчанию, s — только сессия, esc — отмена', () => {
    expect(pickerKey(s0, 'Enter').action).toEqual({ kind: 'choose', alias: 'fable', effort: null, persist: true })
    const touched = pickerKey(s0, 'ArrowRight').state
    expect(pickerKey(touched, 's').action).toEqual({ kind: 'choose', alias: 'fable', effort: 'high', persist: false })
    expect(pickerKey(s0, 'S').action).toMatchObject({ persist: false })
    expect(pickerKey(s0, 'Escape').action).toEqual({ kind: 'cancel' })
    expect(pickerKey(s0, 'x')).toMatchObject({ handled: false, action: null })
  })
})
