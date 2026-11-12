// Чистая логика попапа-выборки для `claude …` (оболочка) и `/…` (режим Claude):
// когда открывается, какие строки и в каком порядке, что подставляется.
import { fuzzyScore } from './completion'

export type HintGroup = 'card' | 'tui' | 'service' | 'builtin' | 'project' | 'user'

export interface HintItem {
  /** Варианты написания (`-c`, `--continue`); подставляется совпавший лучше всех, иначе первый. */
  aliases: string[]
  description: string
  group: HintGroup
  /** Строка «открыть режим Claude»: подставлять нечего, ↵ выполняет строку как есть. */
  enter?: boolean
}

export const GROUP_TITLES: Record<HintGroup, string> = {
  card: 'Режим карточек',
  tui: 'Полный экран',
  service: 'Служебные',
  builtin: 'Встроенные',
  project: 'Проект',
  user: 'Личные',
}

export const GROUP_GLYPHS: Record<HintGroup, string> = {
  card: '◆',
  tui: '▣',
  service: '⚙',
  builtin: '/',
  project: '/',
  user: '/',
}

const GROUP_ORDER: HintGroup[] = ['card', 'tui', 'service', 'builtin', 'project', 'user']

export const ENTER_ROW: HintItem = {
  aliases: ['claude'],
  description: 'Открыть режим Claude',
  group: 'card',
  enter: true,
}

export const CLAUDE_OPTIONS: HintItem[] = [
  { aliases: ['--tui'], description: 'Полноэкранный Claude Code', group: 'tui' },
  { aliases: ['-c', '--continue'], description: 'Продолжить последний разговор (полный экран)', group: 'tui' },
  { aliases: ['-r', '--resume'], description: 'Выбрать разговор (полный экран)', group: 'tui' },
  { aliases: ['--version'], description: 'Версия Claude Code', group: 'service' },
  { aliases: ['mcp'], description: 'MCP-серверы', group: 'service' },
  { aliases: ['config'], description: 'Настройки', group: 'service' },
  { aliases: ['update'], description: 'Обновить', group: 'service' },
  { aliases: ['doctor'], description: 'Проверка установки', group: 'service' },
  { aliases: ['agents'], description: 'Агенты', group: 'service' },
  { aliases: ['plugin'], description: 'Плагины', group: 'service' },
]

export const BUILTIN_SLASH: HintItem[] = [
  ['exit', 'Выйти из режима Claude'],
  ['clear', 'Очистить контекст разговора'],
  ['compact', 'Сжать контекст'],
  ['model', 'Сменить модель'],
  ['cost', 'Стоимость сессии'],
  ['context', 'Заполненность контекста'],
  ['init', 'Создать CLAUDE.md'],
  ['review', 'Ревью изменений'],
].map(([name, description]) => ({ aliases: ['/' + name], description, group: 'builtin' as const }))

/** Ответ `claude_slash_commands`. */
export interface SlashCommandTS {
  name: string
  description: string
  source: 'project' | 'user'
}

export function customSlashItems(cmds: SlashCommandTS[]): HintItem[] {
  return cmds
    .filter((c) => c.name !== '' && !/[\s\x00-\x1f\x7f]/.test(c.name))
    .map((c) => ({ aliases: ['/' + c.name], description: c.description, group: c.source }))
}

export interface HintContext {
  kind: 'claude' | 'slash'
  /** Начало набираемого токена (UTF-16) в строке ввода. */
  tokenStart: number
  /** Набранный токен (для `/` — с косой чертой). */
  token: string
  /** Строка — ровно `claude` (без пробела): подставляемый токен идёт после пробела. */
  bare: boolean
}

/**
 * Когда открыт попап. Оболочка: `claude`, `claude `, `claude <первый аргумент>`; режим Claude:
 * `/`, `/<имя>`. Курсор — в конце строки (после него только пробелы), строка однострочная.
 * cursor — индекс UTF-16.
 */
export function hintContext(buffer: string, cursor: number, mode: 'shell' | 'claude'): HintContext | null {
  if (buffer.includes('\n') || cursor < 0 || cursor > buffer.length) return null
  if (buffer.slice(cursor).trim() !== '') return null
  const before = buffer.slice(0, cursor)
  if (mode === 'claude') {
    const m = /^\/(\S*)$/.exec(before)
    return m ? { kind: 'slash', tokenStart: 0, token: before, bare: false } : null
  }
  const m = /^(\s*claude)(?:([ \t]+)(\S*))?$/.exec(before)
  if (!m) return null
  if (m[2] === undefined) return { kind: 'claude', tokenStart: m[1].length, token: '', bare: true }
  return { kind: 'claude', tokenStart: m[1].length + m[2].length, token: m[3], bare: false }
}

export function hintQuery(ctx: HintContext): string {
  return ctx.kind === 'slash' ? ctx.token.slice(1) : ctx.token
}

export interface HintRow {
  item: HintItem
  /** Индекс совпавшего варианта в item.aliases. */
  alias: number
}

const fold = (s: string) => s.normalize('NFC').toLowerCase()

/** Совпадение с началом варианта или его части `dir:name`; null — не префикс. */
function prefixScore(query: string, alias: string): number | null {
  const q = fold(query)
  const a = fold(alias)
  if (a.startsWith(q)) return 2000 - Math.min(a.length, 999)
  if (a.split(':').slice(1).some((seg) => seg.startsWith(q))) return 1000 - Math.min(a.length, 999)
  return null
}

function bestAlias(
  query: string,
  item: HintItem,
  slash: boolean,
  score: (q: string, a: string) => number | null,
): { score: number; alias: number } | null {
  let best: { score: number; alias: number } | null = null
  item.aliases.forEach((a, i) => {
    const s = score(query, slash ? a.slice(1) : a)
    if (s !== null && (best === null || s > best.score)) best = { score: s, alias: i }
  })
  return best
}

/**
 * Строки попапа: группы в постоянном порядке, внутри группы — по качеству совпадения
 * (при равенстве — исходный порядок). Пустой запрос — весь список. Если запрос — начало
 * какой-то команды (варианта или части `dir:name`), показываются только такие; нечёткий
 * поиск — лишь когда префиксных совпадений нет.
 */
export function rankHints(ctx: HintContext, items: HintItem[]): HintRow[] {
  const query = hintQuery(ctx)
  const slash = ctx.kind === 'slash'
  const all = (ctx.bare ? [ENTER_ROW, ...items] : items).filter((item) => !(item.enter && query !== ''))
  const collect = (score: (q: string, a: string) => number | null) => {
    const out: { row: HintRow; score: number; order: number }[] = []
    all.forEach((item, order) => {
      const b = bestAlias(query, item, slash, score)
      if (b) out.push({ row: { item, alias: b.alias }, score: b.score, order })
    })
    return out
  }
  let scored = query === '' ? [] : collect(prefixScore)
  if (scored.length === 0) scored = collect(fuzzyScore)
  scored.sort((a, b) => {
    const g = GROUP_ORDER.indexOf(a.row.item.group) - GROUP_ORDER.indexOf(b.row.item.group)
    if (g !== 0) return g
    return b.score - a.score || a.order - b.order
  })
  return scored.map((s) => s.row)
}

/** Строка ввода после подстановки строки row (с пробелом после токена). */
export function applyHint(buffer: string, ctx: HintContext, row: HintRow): { value: string; cursor: number } {
  if (row.item.enter) return { value: buffer, cursor: buffer.length }
  const insert = (ctx.bare ? ' ' : '') + row.item.aliases[row.alias] + ' '
  const end = ctx.tokenStart + ctx.token.length
  const head = buffer.slice(0, ctx.tokenStart) + insert
  return { value: head + buffer.slice(end).trimStart(), cursor: head.length }
}
