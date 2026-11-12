// Выбор модели и усилия (`/model` в режиме Claude): список моделей, клавиши карточки выбора,
// управляющие запросы stream-json. Чистая логика.
import { modelLabel } from './labels'

export interface ModelRow {
  /** Что принимает `claude --model` и `set_model`; `default` — модель Claude Code по умолчанию. */
  alias: string
  label: string
  description: string
}

export const MODEL_ROWS: ModelRow[] = [
  { alias: 'default', label: 'Default (рекомендуется)', description: 'Opus 5.5 · для повседневных и сложных задач' },
  { alias: 'opus', label: 'Opus 5.5', description: 'Сложная работа и повседневные задачи' },
  { alias: 'fable', label: 'Fable 5.2', description: 'Самые трудные задачи' },
  { alias: 'sonnet', label: 'Sonnet 5.5', description: 'Эффективна для простых задач' },
  { alias: 'haiku', label: 'Haiku 5.5', description: 'Самые быстрые ответы' },
]

/** Уровни `claude --effort`. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type Effort = (typeof EFFORTS)[number]
const DEFAULT_EFFORT = 'medium'

const FAMILIES = ['opus', 'fable', 'sonnet', 'haiku']

/** Псевдоним семейства: `opus[1m]` → opus, `claude-fable-5-2` → fable; не узнали — null. */
export function aliasOf(model: string | null | undefined): string | null {
  if (!model) return null
  const m = model.toLowerCase().replace(/\[[^\]]*\]$/, '')
  return FAMILIES.find((f) => m === f || m.startsWith(`claude-${f}-`)) ?? null
}

export const setModelRequest = (alias: string) => ({ subtype: 'set_model', model: alias })
/** Усилие живой сессии: флаговые настройки процесса (`set_effort` в протоколе нет). */
export const effortRequest = (effort: string) => ({ subtype: 'apply_flag_settings', settings: { effortLevel: effort } })
export const GET_SETTINGS = { subtype: 'get_settings' }

/**
 * Что записать в `model` настроек: псевдоним; суффикс контекста (`[1m]`) из прежнего значения
 * сохраняется, если семейство то же. Default — null (ключ удаляется).
 */
export function persistedModel(alias: string, current: string | null | undefined): string | null {
  if (alias === 'default') return null
  const suffix = /\[[^\]]*\]$/.exec(current ?? '')?.[0]
  return suffix && aliasOf(current) === alias ? alias + suffix : alias
}

/** Заметка в ленте после выбора: «Модель: Fable 5.2 · усилие high». */
export function modelNote(model: string, effort: string | null): string {
  const m = `Модель: ${modelLabel(model)}`
  return effort ? `${m} · усилие ${effort}` : m
}

export interface PickerState {
  selected: number
  effort: number
  /** Усилие меняли ←/→: только тогда оно применяется и сохраняется. */
  effortTouched: boolean
}

/** Выбор в карточке модели. */
export interface ModelChoice {
  /** Псевдоним из MODEL_ROWS (`default`, `opus`, `fable`, …). */
  alias: string
  /** Новое усилие; null — не меняли. */
  effort: Effort | null
  /** ↵ — ещё и по умолчанию для новых сессий (settings.json Claude Code); s — только эта сессия. */
  persist: boolean
}

export type PickerAction = ({ kind: 'choose' } & ModelChoice) | { kind: 'cancel' }

/** current — псевдоним текущей модели (null/неизвестная — Default), effort — текущее усилие. */
export function initialPicker(current: string | null, effort: string | null): PickerState {
  const i = MODEL_ROWS.findIndex((r) => r.alias === current)
  const e = EFFORTS.indexOf((effort ?? DEFAULT_EFFORT) as Effort)
  return { selected: Math.max(0, i), effort: e >= 0 ? e : EFFORTS.indexOf(DEFAULT_EFFORT), effortTouched: false }
}

export function pickerKey(
  s: PickerState,
  key: string,
): { state: PickerState; action: PickerAction | null; handled: boolean } {
  const n = MODEL_ROWS.length
  const done = (state: PickerState, action: PickerAction | null = null) => ({ state, action, handled: true })
  const choose = (persist: boolean): PickerAction => ({
    kind: 'choose',
    alias: MODEL_ROWS[s.selected].alias,
    effort: s.effortTouched ? EFFORTS[s.effort] : null,
    persist,
  })
  switch (key) {
    case 'ArrowDown':
      return done({ ...s, selected: (s.selected + 1) % n })
    case 'ArrowUp':
      return done({ ...s, selected: (s.selected - 1 + n) % n })
    case 'ArrowLeft':
      return done({ ...s, effort: Math.max(0, s.effort - 1), effortTouched: true })
    case 'ArrowRight':
      return done({ ...s, effort: Math.min(EFFORTS.length - 1, s.effort + 1), effortTouched: true })
    case 'Enter':
      return done(s, choose(true))
    case 's':
    case 'S':
      return done(s, choose(false))
    case 'Escape':
      return done(s, { kind: 'cancel' })
  }
  if (/^[1-9]$/.test(key) && Number(key) <= n) return done({ ...s, selected: Number(key) - 1 })
  return { state: s, action: null, handled: false }
}
