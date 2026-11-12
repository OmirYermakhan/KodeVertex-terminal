import type { ThemeId } from '../theme/themes'

export interface Settings {
  theme: ThemeId
  textFont: string
  codeFont: string
  textSize: number
  codeSize: number
  lineHeight: 1.5 | 1.6 | 1.7 | 1.8
  ligatures: boolean
  /** Попап подсказок путей в терминале. */
  pathCompletions: boolean
  /** Системные уведомления, когда окно не в фокусе или событие в другой вкладке. */
  notifySystem: boolean
  notifySound: boolean
  /** Уведомлять о субагентах (главный — всегда). */
  notifySubagents: boolean
  /** Уведомлять о командах дольше 10 с. */
  notifyLongCommands: boolean
}

export const DEFAULTS: Settings = {
  theme: 'as',
  textFont: 'Inter',
  codeFont: 'JetBrains Mono',
  textSize: 16,
  codeSize: 13,
  lineHeight: 1.7,
  ligatures: true,
  pathCompletions: true,
  notifySystem: true,
  notifySound: true,
  notifySubagents: false,
  notifyLongCommands: true,
}

const THEME_IDS: ThemeId[] = ['kv', 'warm', 'cold', 'light', 'as']
const LINE_HEIGHTS: Settings['lineHeight'][] = [1.5, 1.6, 1.7, 1.8]
const RANGES = { text: [11, 28], code: [10, 24] } as const

function clampSize(v: unknown, kind: 'text' | 'code', fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
  const [min, max] = RANGES[kind]
  return Math.min(max, Math.max(min, Math.round(v)))
}

function nearestLineHeight(v: unknown): Settings['lineHeight'] {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULTS.lineHeight
  // ties round up; distances rounded to avoid float noise (1.65 is equidistant from 1.6 and 1.7)
  const dist = (c: number) => Math.round(Math.abs(c - v) * 1e6)
  return LINE_HEIGHTS.reduce((best, c) => (dist(c) <= dist(best) ? c : best))
}

/** Старые значения, которые не являются CSS-семействами. */
const FONT_ALIASES: Record<string, string> = { 'SF Mono': 'ui-monospace' }

function fontName(v: unknown, fallback: string): string {
  if (typeof v !== 'string' || v.trim() === '') return fallback
  return FONT_ALIASES[v.trim()] ?? v.trim()
}

const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback)

export function normalizeSettings(raw: unknown): Settings {
  const r = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    theme: THEME_IDS.includes(r.theme as ThemeId) ? (r.theme as ThemeId) : DEFAULTS.theme,
    textFont: fontName(r.textFont, DEFAULTS.textFont),
    codeFont: fontName(r.codeFont, DEFAULTS.codeFont),
    textSize: clampSize(r.textSize, 'text', DEFAULTS.textSize),
    codeSize: clampSize(r.codeSize, 'code', DEFAULTS.codeSize),
    lineHeight: nearestLineHeight(r.lineHeight),
    ligatures: typeof r.ligatures === 'boolean' ? r.ligatures : DEFAULTS.ligatures,
    pathCompletions: typeof r.pathCompletions === 'boolean' ? r.pathCompletions : DEFAULTS.pathCompletions,
    notifySystem: bool(r.notifySystem, DEFAULTS.notifySystem),
    notifySound: bool(r.notifySound, DEFAULTS.notifySound),
    notifySubagents: bool(r.notifySubagents, DEFAULTS.notifySubagents),
    notifyLongCommands: bool(r.notifyLongCommands, DEFAULTS.notifyLongCommands),
  }
}

export function stepSize(current: number, delta: 1 | -1, kind: 'text' | 'code'): number {
  const [min, max] = RANGES[kind]
  return Math.min(max, Math.max(min, current + delta))
}

export function terminalLineHeight(s: Settings): number {
  return Math.round(s.lineHeight * 0.8 * 100) / 100
}
