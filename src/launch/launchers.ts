/**
 * Быстрые входы: сохранённая команда (обычно `ssh user@host`), значок и цвет. Каждый вход —
 * своя вкладка; кнопка в полосе слева открывает её и запускает команду, если она не идёт.
 */
export const LAUNCHER_ICONS = [
  'server',
  'cloud',
  'database',
  'box',
  'globe',
  'terminal',
  'key',
  'rocket',
  'shield',
  'cpu',
  'flame',
  'git',
] as const
export type LauncherIcon = (typeof LAUNCHER_ICONS)[number]

/** Цвета значков: читаются и на тёмной, и на светлой полосе. */
export const LAUNCHER_COLORS = ['#4f8cff', '#3fb950', '#e3a33b', '#a371f7', '#f0646e', '#2bb5b0', '#8b929b'] as const

export interface Launcher {
  id: string
  name: string
  command: string
  icon: LauncherIcon
  color: string
  /** Папка проекта: вкладка открывается в ней. */
  cwd?: string
  /** Своя картинка вместо значка (data URL, png). */
  image?: string
}

export const MAX_LAUNCHERS = 40
const MAX_NAME = 60
const MAX_COMMAND = 4000
export const MAX_IMAGE = 64 * 1024
const IMAGE_PREFIX = 'data:image/png;base64,'

/** Последний сегмент пути: `/a/b/proj/` → `proj`, `/` → `/`. */
export function folderName(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts.length ? parts[parts.length - 1] : '/'
}

const isHexColor = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)

/** Входы из файла настроек: битые записи выбрасываются, повторные id — тоже. */
export function normalizeLaunchers(raw: unknown): Launcher[] {
  if (!Array.isArray(raw)) return []
  const out: Launcher[] = []
  const ids = new Set<string>()
  for (const r of raw) {
    if (r === null || typeof r !== 'object') continue
    const x = r as Record<string, unknown>
    if (typeof x.id !== 'string' || x.id === '' || ids.has(x.id)) continue
    const command = typeof x.command === 'string' ? x.command.trim() : ''
    const cwd = typeof x.cwd === 'string' && x.cwd.startsWith('/') && x.cwd.trim() !== '' ? x.cwd : undefined
    if (command === '' && !cwd) continue
    const fallback = command !== '' ? command : folderName(cwd as string)
    const name = typeof x.name === 'string' && x.name.trim() !== '' ? x.name.trim() : fallback
    const image =
      typeof x.image === 'string' && x.image.startsWith(IMAGE_PREFIX) && x.image.length <= MAX_IMAGE ? x.image : undefined
    ids.add(x.id)
    out.push({
      id: x.id,
      name: name.slice(0, MAX_NAME),
      command: command.slice(0, MAX_COMMAND),
      icon: LAUNCHER_ICONS.includes(x.icon as LauncherIcon) ? (x.icon as LauncherIcon) : 'server',
      color: isHexColor(x.color) ? x.color : LAUNCHER_COLORS[0],
      ...(cwd ? { cwd } : {}),
      ...(image ? { image } : {}),
    })
    if (out.length >= MAX_LAUNCHERS) break
  }
  return out
}

/** Имя по умолчанию из команды: `ssh -p 22 deploy@10.0.0.5` → `deploy@10.0.0.5`. */
export function suggestName(command: string): string {
  const words = command.trim().split(/\s+/)
  if (words[0] === 'ssh' || words[0] === 'mosh') {
    const host = words.slice(1).find((w, i, a) => !w.startsWith('-') && !(i > 0 && /^-[pliFJoEc]$/.test(a[i - 1])))
    if (host) return host
  }
  return command.trim().slice(0, 24)
}
