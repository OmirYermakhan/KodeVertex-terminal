// Сессия окна между запусками: вкладки и раскладка панелей, каталоги, Claude-сессии панелей,
// лента (замороженные блоки и карточки), очередь сообщений и режим Claude. Файл пишет Rust
// (session_save, атомарно); здесь — снимок, его урезание по размеру и восстановление.
import { invoke } from '@tauri-apps/api/core'
import { leaves, type PaneNode } from '../layout/paneTree'
import { useTabs, type Tab } from '../layout/tabsStore'
import { useClaudeSessions, type PaneClaude, type QueuedMessage } from '../claude/sessionStore'
import { cancelPrompts, initialClaude, type ClaudeState, type FeedClaudeItem } from '../claude/reducer'
import { boundDiff } from '../claude/diff'
import { claudeIndex, claudeItemId, type FeedItem, type ShellBlock } from '../feed/feed'
import type { Attachment } from '../attach/types'
import { logError } from '../diag/log'

export const SESSION_VERSION = 1
/**
 * Предел файла в байтах UTF-8: больше — выбрасываются самые старые блоки оболочки. С запасом ниже
 * предела Rust (24 МБ), иначе session_save молча отказывал бы.
 */
export const MAX_SESSION_BYTES = 20 * 1024 * 1024
/** Замороженный вывод одного блока длиннее — не сохраняется (блок остаётся без вывода). */
export const MAX_BLOCK_HTML = 1024 * 1024
export const SAVE_DELAY_MS = 1000
/** Дольше этого запись не откладывается, даже если изменения идут без пауз (поток ответа Claude). */
export const SAVE_MAX_WAIT_MS = 5000

/** Элемент ленты в файле: блок оболочки целиком, карточка Claude — ссылкой на индекс в её сессии. */
export type SavedFeedItem = ShellBlock | { kind: 'claude'; id: string }

export interface SavedClaude {
  cwd: string | null
  model: string | null
  effort: string | null
  closed: boolean
  queue: QueuedMessage[]
  state: Pick<
    ClaudeState,
    'sessionId' | 'model' | 'effort' | 'defaultModel' | 'contextUsed' | 'contextMax' | 'costUsd' | 'costBase' | 'costProc' | 'costOf' | 'costUnknown' | 'items' | 'chain' | 'epoch' | 'edits'
  >
}

export interface SavedPane {
  feed: SavedFeedItem[]
  /** ⌃L: карточки Claude с меньшим индексом в ленте не показываются. */
  claudeFrom: number
  claudeMode: boolean
  claude?: SavedClaude
}

export interface SavedSession {
  version: number
  tabs: Tab[]
  active: string
  panes: Record<string, SavedPane>
}

/** Что панель отдаёт для снимка (регистрирует TerminalPane). */
export interface PaneFeed {
  items: readonly FeedItem[]
  claudeFrom: number
  claudeMode: boolean
}

/** Лента смонтированных панелей: читается в момент снимка. */
const feeds = new Map<string, () => PaneFeed>()
/**
 * Восстановленное для панелей, ещё не отдавших свою ленту (не смонтированных). keep — лента принята
 * из другого окна (перенос вкладки): блоки как есть, идущий остаётся идущим.
 */
const restored = new Map<string, Omit<SavedPane, 'claude'> & { keep?: boolean }>()

/** Панель отдаёт свою ленту; восстановленное для неё больше не нужно. */
export function setPaneFeed(paneId: string, f: () => PaneFeed): void {
  feeds.set(paneId, f)
  restored.delete(paneId)
}

export function dropPaneFeed(paneId: string, f: () => PaneFeed): void {
  if (feeds.get(paneId) === f) feeds.delete(paneId)
}

/**
 * Восстановленная лента панели (элементы Claude — уже из её восстановленной сессии). Не забирает:
 * в StrictMode инициализатор состояния вызывается дважды.
 */
export function restoredPane(paneId: string): PaneFeed | null {
  const r = restored.get(paneId)
  if (!r) return null
  const items = useClaudeSessions.getState().sessions[paneId]?.state.items ?? []
  const feed: FeedItem[] = []
  for (const it of r.feed) {
    if (it.kind === 'shell') {
      if (r.keep) {
        feed.push(it)
        continue
      }
      // Файл подправлен руками: «создан в этом запуске» у восстановленного блока не бывает.
      const { live: _live, ...b } = it
      feed.push(b)
    }
    else {
      const i = claudeIndex(it.id)
      if (i >= 0 && i < items.length) feed.push({ kind: 'claude', id: claudeItemId(i), item: items[i] })
    }
  }
  return { items: feed, claudeFrom: r.claudeFrom, claudeMode: r.claudeMode }
}

function saveBlock(block: ShellBlock): ShellBlock {
  // «Создан в этом запуске» в файл не идёт: после перезапуска HTML блока читается с диска и проверяется.
  const { live: _live, ...b } = block
  const html = b.html !== null && b.html.length > MAX_BLOCK_HTML ? null : b.html
  if (!b.running) return html === b.html ? b : { ...b, html, lines: html === null ? 0 : b.lines }
  // Шла при закрытии: живой xterm не сохранить — законченный блок «прервано» без вывода.
  return { ...b, running: false, interrupted: true, exitCode: null, html: null, lines: 0, durationMs: Math.max(0, Date.now() - b.startedAt) }
}

/** Итогов сессий по id в файле не больше (последние — линия правок; см. ClaudeState.costOf). */
export const MAX_COST_OF = 32

/**
 * from — граница ленты (⌃L, /clear, /resume): элементы до неё не видны и уже не меняются, в файл
 * они идут как 'gone' (индексы для edits и chain не сдвигаются), иначе каждый `/resume` с историей
 * навсегда увеличивал бы файл.
 */
function saveClaude(p: PaneClaude, from: number): SavedClaude {
  const s = p.state
  const costOf = Object.entries(s.costOf ?? {}).slice(-MAX_COST_OF)
  return {
    cwd: p.cwd,
    model: p.model,
    effort: p.effort,
    closed: !!p.closed,
    queue: p.queue,
    state: {
      sessionId: s.sessionId,
      model: s.model,
      effort: s.effort,
      defaultModel: s.defaultModel,
      contextUsed: s.contextUsed,
      contextMax: s.contextMax,
      costUsd: s.costUsd,
      costBase: s.costBase ?? 0,
      costProc: s.costProc ?? 0,
      costOf: Object.fromEntries(costOf),
      costUnknown: s.costUnknown === true,
      items: s.items.map((it, i): FeedClaudeItem => (i < from ? { type: 'gone' } : saveItem(it))),
      chain: s.chain,
      epoch: s.epoch,
      edits: s.edits,
    },
  }
}

/**
 * Снимок панелей вкладок. live — для переноса вкладки в другое окно (не в файл): блоки оболочки
 * как есть — идущий не становится «прервано», вывод не урезается.
 */
export function snapshotPanes(tabs: readonly Tab[], opts: { live?: boolean } = {}): Record<string, SavedPane> {
  const sessions = useClaudeSessions.getState().sessions
  const panes: Record<string, SavedPane> = {}
  const block = opts.live ? (b: ShellBlock) => b : saveBlock
  for (const t of tabs) {
    for (const id of leaves(t.tree)) {
      const f = feeds.get(id)?.()
      const r = restored.get(id)
      const c = sessions[id]
      const claudeFrom = f?.claudeFrom ?? r?.claudeFrom ?? 0
      panes[id] = {
        feed: f
          ? f.items.map((it): SavedFeedItem => (it.kind === 'shell' ? block(it) : { kind: 'claude', id: it.id }))
          : (r?.feed ?? []),
        claudeFrom,
        claudeMode: f?.claudeMode ?? r?.claudeMode ?? false,
        ...(c ? { claude: saveClaude(c, claudeFrom) } : {}),
      }
    }
  }
  return panes
}

export function snapshot(): SavedSession {
  const { tabs, active } = useTabs.getState()
  return { version: SESSION_VERSION, tabs, active, panes: snapshotPanes(tabs) }
}

/** Вкладка принята из другого окна: ленты её панелей ждут монтирования (как восстановленные). */
export function stageTransferredPane(paneId: string, p: SavedPane): void {
  restored.set(paneId, {
    feed: Array.isArray(p.feed) ? p.feed : [],
    claudeFrom: typeof p.claudeFrom === 'number' ? p.claudeFrom : 0,
    claudeMode: p.claudeMode === true,
    keep: true,
  })
}

/** Сессия Claude панели из файла или переноса (без процесса): как после перезапуска. */
export function restoredClaude(c: SavedClaude): PaneClaude {
  return restoreClaude(c)
}


/** Длина строки в UTF-8 (Rust мерит байты, не символы UTF-16) — без выделения буфера. */
export function utf8Length(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4
      i++
    } else n += 3
  }
  return n
}

/** Байты элемента в массиве JSON: сам элемент и запятая. */
const itemBytes = (v: unknown) => utf8Length(JSON.stringify(v)) + 1
const GONE_BYTES = utf8Length(JSON.stringify({ type: 'gone' }))

/**
 * JSON снимка не больше `max` байт UTF-8: выбрасываются самые старые блоки оболочки (по всем
 * панелям), а если их не хватило — самые ранние элементы Claude становятся 'gone' (индексы не
 * сдвигаются). Что выбросить — считается по размерам элементов, снимок сериализуется заново один раз.
 */
export function serializeCapped(s: SavedSession, max = MAX_SESSION_BYTES): string {
  let text = JSON.stringify(s)
  let size = utf8Length(text)
  const full = size
  // Оценка по элементам точна до запятых; на случай промаха — ещё проход с уменьшенным бюджетом.
  for (let budget = max, pass = 0; size > max && pass < 3; pass++) {
    text = JSON.stringify(trim(s, full - budget))
    size = utf8Length(text)
    budget -= size - max + 64
  }
  return text
}

/** Снимок без `excess` байт: сначала старые блоки оболочки, затем ранние элементы Claude. */
function trim(s: SavedSession, excess: number): SavedSession {
  let need = excess
  const blocks: ShellBlock[] = []
  for (const p of Object.values(s.panes)) for (const it of p.feed) if (it.kind === 'shell') blocks.push(it)
  blocks.sort((x, y) => x.startedAt - y.startedAt)
  const drop = new Set<ShellBlock>()
  for (const b of blocks) {
    if (need <= 0) break
    drop.add(b)
    need -= itemBytes(b)
  }
  const panes: Record<string, SavedPane> = {}
  for (const [id, p] of Object.entries(s.panes)) panes[id] = drop.size ? { ...p, feed: p.feed.filter((it) => !(it.kind === 'shell' && drop.has(it))) } : p
  if (need > 0) {
    const left: { pane: string; i: number }[] = []
    for (const [id, p] of Object.entries(panes)) (p.claude?.state.items ?? []).forEach((it, i) => it.type !== 'gone' && left.push({ pane: id, i }))
    left.sort((x, y) => x.i - y.i)
    const gone = new Map<string, Set<number>>()
    for (const { pane, i } of left) {
      if (need <= 0) break
      need -= itemBytes(panes[pane].claude!.state.items[i]) - 1 - GONE_BYTES
      if (!gone.has(pane)) gone.set(pane, new Set())
      gone.get(pane)!.add(i)
    }
    for (const [pane, set] of gone) {
      const c = panes[pane].claude!
      const items = c.state.items.map((it, i): FeedClaudeItem => (set.has(i) ? { type: 'gone' } : it))
      panes[pane] = { ...panes[pane], claude: { ...c, state: { ...c.state, items } } }
    }
  }
  return { ...s, panes }
}

let timer: ReturnType<typeof setTimeout> | undefined
/** Срок, позже которого отложенная запись не сдвигается (первое изменение + SAVE_MAX_WAIT_MS). */
let dueBy = 0
let enabled = false
/** Файл сессии другой версии: не перезаписывать ни автосохранением, ни при выходе. */
let foreign = false
/** Окно закрывается без вкладок (все уехали): его часть сессии не пишется, даже при beforeunload. */
let closing = false

export function scheduleSave(): void {
  if (!enabled) return
  const now = Date.now()
  if (timer === undefined) dueBy = now + SAVE_MAX_WAIT_MS
  clearTimeout(timer)
  timer = setTimeout(saveNow, Math.max(0, Math.min(SAVE_DELAY_MS, dueBy - now)))
}

export function saveNow(): Promise<void> {
  clearTimeout(timer)
  timer = undefined
  if (foreign || closing) return Promise.resolve()
  return invoke('session_save', { text: serializeCapped(snapshot()) }).then(
    () => {},
    () => {},
  )
}

/**
 * Закрытие окна: последняя запись, дальше автосохранение выключено — выход оболочек при
 * закрытии не должен затереть сохранённые вкладки.
 */
export function finalSave(): Promise<void> {
  const p = saveNow()
  enabled = false
  return p
}

/**
 * Окно закрывается, отдав последнюю вкладку в другое окно: без записи (его часть сессии Rust
 * забудет сам), дальше автосохранение выключено.
 */
export function stopAutosave(): void {
  clearTimeout(timer)
  timer = undefined
  enabled = false
  closing = true
}

/**
 * Автосохранение этого окна: после restoreSession (main) или запуска другого окна. Повторный
 * вызов ничего не делает.
 */
let subscribed = false
export function enableAutosave(): void {
  if (foreign) return
  enabled = true
  if (subscribed) return
  subscribed = true
  useTabs.subscribe(scheduleSave)
  useClaudeSessions.subscribe(scheduleSave)
}

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function validTree(n: unknown): n is PaneNode {
  if (!isRec(n)) return false
  if (n.kind === 'leaf') return typeof n.id === 'string'
  return (n.axis === 'row' || n.axis === 'col') && typeof n.ratio === 'number' && validTree(n.a) && validTree(n.b)
}

function validTab(t: unknown): t is Tab {
  if (!isRec(t) || typeof t.id !== 'string' || !validTree(t.tree) || typeof t.focused !== 'string' || !isRec(t.cwd)) return false
  return leaves(t.tree).includes(t.focused)
}

/** Вкладка из файла без мусора: каталог панели уходит в pty_spawn — только строки. */
function cleanTab(t: Tab): Tab {
  const cwd: Record<string, string> = {}
  for (const [k, v] of Object.entries(t.cwd)) if (typeof v === 'string' && v !== '') cwd[k] = v
  const { launcher, ...rest } = t
  return { ...rest, cwd, ...(typeof launcher === 'string' ? { launcher } : {}) }
}

/** Сообщение очереди из файла: текст — строка, значки — объекты с id/kind/label, каталог — строка. */
function restoreQueued(m: unknown, i: number): QueuedMessage | null {
  if (!isRec(m) || typeof m.text !== 'string') return null
  const tokens = Array.isArray(m.tokens)
    ? m.tokens.filter((a): a is Attachment => isRec(a) && typeof a.id === 'string' && typeof a.kind === 'string' && typeof a.label === 'string')
    : undefined
  return {
    // id очереди — счётчик этого запуска: восстановленным — свои (отрицательные), без совпадений.
    id: -(i + 1),
    text: m.text,
    ...(tokens && tokens.length ? { tokens } : {}),
    ...(typeof m.cwd === 'string' && m.cwd !== '' ? { cwd: m.cwd } : {}),
  }
}

/**
 * Элемент для файла сессии: правка — без исходного файла и не длиннее того, что показывает вид
 * (boundDiff), иначе файл сессии растёт без предела. Восстановленный вид изменений не разворачивает
 * свёрнутые строки, урезанный — заканчивается строкой «… остальные строки не сохранены».
 */
function saveItem(it: FeedClaudeItem): FeedClaudeItem {
  if (it.type === 'action' && it.diff) return { ...it, diff: boundDiff(it.diff) }
  if (it.type === 'replaced') return { ...it, items: it.items.map(saveItem) }
  return it
}

const TODO_STATUSES = new Set(['pending', 'in_progress', 'completed'])
const validTodos = (v: unknown): boolean =>
  Array.isArray(v) &&
  v.every((t) => isRec(t) && typeof t.content === 'string' && TODO_STATUSES.has(t.status as string) && (t.activeForm === undefined || typeof t.activeForm === 'string'))

/** Недоигранное при закрытии: ответ дописан, действия не идут, вопросы и разрешения сняты. */
function restoreItem(it: FeedClaudeItem): FeedClaudeItem {
  // Испорченный план — убрать (на месте элемента 'gone': индексы ленты не сдвигаются).
  if (it.type === 'todo' && (typeof it.agentId !== 'string' || typeof it.toolUseId !== 'string' || !validTodos(it.todos))) return { type: 'gone' }
  if (it.type === 'replaced' && Array.isArray(it.items)) return { ...it, items: it.items.map(restoreItem) }
  if (it.type === 'assistant' && it.streaming) return { ...it, streaming: false }
  if (it.type === 'action' && it.status === 'running') return { ...it, status: 'error', result: it.result ?? 'Прервано: приложение закрылось' }
  return it
}

/**
 * Учёт стоимости из файла. Без costProc (файл версии до учёта по процессам) costUsd и был
 * нарастающим итогом CLI: costProc = costUsd, база 0.
 */
function restoreCost(s: SavedClaude['state']): Pick<ClaudeState, 'costUsd' | 'costBase' | 'costProc' | 'costOf' | 'costUnknown'> {
  const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
  const costUsd = ok(s.costUsd) ? s.costUsd : 0
  const costOf: Record<string, number> = {}
  if (isRec(s.costOf)) for (const [k, v] of Object.entries(s.costOf)) if (ok(v)) costOf[k] = v
  const costUnknown = s.costUnknown === true
  if (!ok(s.costProc)) return { costUsd, costBase: 0, costProc: costUsd, costOf, costUnknown }
  const costProc = s.costProc
  // База — то, что не объясняет итог процесса (так costUsd = costBase + costProc и после порчи файла).
  const costBase = Math.max(0, costUsd - costProc)
  return { costUsd: costBase + costProc, costBase, costProc, costOf, costUnknown }
}

function restoreClaude(c: SavedClaude): PaneClaude {
  const base = initialClaude()
  const s = c.state
  const str = (v: unknown) => (typeof v === 'string' ? v : null)
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
  // Только сохраняемые поля: ход не идёт, агенты — как у новой сессии.
  let state: ClaudeState = {
    ...base,
    sessionId: str(s.sessionId),
    model: str(s.model),
    effort: str(s.effort),
    defaultModel: str(s.defaultModel),
    contextUsed: num(s.contextUsed, 0),
    contextMax: num(s.contextMax, base.contextMax),
    ...restoreCost(s),
    chain: isRec(s.chain) ? s.chain : null,
    epoch: num(s.epoch, 0),
    items: (Array.isArray(c.state.items) ? c.state.items : []).map(restoreItem),
    edits: isRec(c.state.edits) ? c.state.edits : {},
  }
  state = cancelPrompts(state, undefined, 'exit')
  const queue = (Array.isArray(c.queue) ? (c.queue as unknown[]) : []).flatMap((m, i) => restoreQueued(m, i) ?? [])
  return {
    state,
    procId: null,
    cwd: str(c.cwd),
    model: str(c.model),
    effort: str(c.effort),
    permissionMode: null,
    queue,
    // Очередь не уходит сама после перезапуска: ↵ на пустой строке — следующее.
    paused: queue.length > 0,
    pauseHint: false,
    rewindAt: null,
    closed: c.closed === true,
    restored: state.sessionId !== null,
  }
}

/** Применяет сохранённую сессию к сторам. Неподходящая (версия, форма) — false, всё как было. */
export function applySession(raw: unknown): boolean {
  if (!isRec(raw) || raw.version !== SESSION_VERSION || !Array.isArray(raw.tabs)) return false
  const tabs = raw.tabs.filter(validTab).map(cleanTab)
  if (tabs.length === 0) return false
  const active = typeof raw.active === 'string' && tabs.some((t) => t.id === raw.active) ? raw.active : tabs[0].id
  const panes = isRec(raw.panes) ? (raw.panes as Record<string, SavedPane>) : {}
  const sessions: Record<string, PaneClaude> = {}
  restored.clear()
  for (const t of tabs) {
    for (const id of leaves(t.tree)) {
      const p = panes[id]
      if (!isRec(p)) continue
      if (isRec(p.claude) && isRec(p.claude.state)) sessions[id] = restoreClaude(p.claude)
      restored.set(id, {
        feed: Array.isArray(p.feed) ? p.feed.filter((it) => isRec(it) && (it.kind === 'shell' || it.kind === 'claude')) : [],
        claudeFrom: typeof p.claudeFrom === 'number' ? p.claudeFrom : 0,
        claudeMode: p.claudeMode === true,
      })
    }
  }
  useTabs.setState({ tabs, active, respawns: [] })
  useClaudeSessions.setState({ sessions })
  return true
}

/** Тост: файл сессии записан более новой сборкой. */
export const FOREIGN_NOTICE = 'session.json другой версии — сессия не восстановлена и не сохраняется в этом запуске'

/**
 * Загрузка при старте (до первого рендера панелей) и автосохранение изменений. Файл более новой
 * версии (записан более новой сборкой) не затирается: копии Rust не делает, поэтому автосохранение
 * в этом запуске выключено и об этом говорит тост — вкладки этой сборки не сохранятся, зато чужая
 * сессия цела. Без версии, старой версии или битый — не применяется, дальше сохраняется новая.
 */
export async function restoreSession(): Promise<void> {
  let raw: unknown = null
  try {
    raw = await invoke('session_load')
  } catch {
    raw = null
  }
  applySession(raw)
  if (isRec(raw) && typeof raw.version === 'number' && raw.version > SESSION_VERSION) {
    foreign = true
    logError('session', `файл сессии версии ${String(raw.version)} (ожидалась ${SESSION_VERSION}): не применён и не перезаписывается`)
    // Лениво: notify сам импортирует сторы, которые импортирует этот модуль.
    void import('../notify/notify')
      .then((m) => m.useToasts.getState().push({ kind: 'error', text: FOREIGN_NOTICE, paneId: '', agentId: null }))
      .catch(() => {})
    return
  }
  // Файл этой версии (или его нет): Rust может писать его — в том числе частями окон `w-*`. До
  // этого (файл более новой сборки) их записи файл не трогают.
  invoke('session_confirm').catch(() => {})
  enableAutosave()
}

/** Для тестов: начальное состояние модуля. */
export function resetPersistForTests(): void {
  clearTimeout(timer)
  timer = undefined
  enabled = false
  foreign = false
  closing = false
  feeds.clear()
  restored.clear()
}
