// Сессия окна между запусками: вкладки и раскладка панелей, каталоги, Claude-сессии панелей,
// лента (замороженные блоки и карточки), очередь сообщений и режим Claude. Файл пишет Rust
// (session_save, атомарно); здесь — снимок, его урезание по размеру и восстановление.
import { invoke } from '@tauri-apps/api/core'
import { leaves, type PaneNode } from '../layout/paneTree'
import { useTabs, type Tab } from '../layout/tabsStore'
import { useClaudeSessions, type PaneClaude, type QueuedMessage } from '../claude/sessionStore'
import { cancelPrompts, initialClaude, type ClaudeState, type FeedClaudeItem } from '../claude/reducer'
import { claudeIndex, claudeItemId, type FeedItem, type ShellBlock } from '../feed/feed'

export const SESSION_VERSION = 1
/** Предел файла: больше — выбрасываются самые старые блоки оболочки. */
export const MAX_SESSION_BYTES = 20 * 1024 * 1024
/** Замороженный вывод одного блока длиннее — не сохраняется (блок остаётся без вывода). */
export const MAX_BLOCK_HTML = 1024 * 1024
export const SAVE_DELAY_MS = 1000

/** Элемент ленты в файле: блок оболочки целиком, карточка Claude — ссылкой на индекс в её сессии. */
export type SavedFeedItem = ShellBlock | { kind: 'claude'; id: string }

export interface SavedClaude {
  cwd: string | null
  model: string | null
  effort: string | null
  closed: boolean
  queue: QueuedMessage[]
  state: Pick<ClaudeState, 'sessionId' | 'model' | 'effort' | 'defaultModel' | 'contextUsed' | 'contextMax' | 'costUsd' | 'items' | 'chain' | 'epoch' | 'edits'>
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
/** Восстановленное для панелей, ещё не отдавших свою ленту (не смонтированных). */
const restored = new Map<string, Omit<SavedPane, 'claude'>>()

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
    if (it.kind === 'shell') feed.push(it)
    else {
      const i = claudeIndex(it.id)
      if (i >= 0 && i < items.length) feed.push({ kind: 'claude', id: claudeItemId(i), item: items[i] })
    }
  }
  return { items: feed, claudeFrom: r.claudeFrom, claudeMode: r.claudeMode }
}

function saveBlock(b: ShellBlock): ShellBlock {
  const html = b.html !== null && b.html.length > MAX_BLOCK_HTML ? null : b.html
  if (!b.running) return html === b.html ? b : { ...b, html, lines: html === null ? 0 : b.lines }
  // Шла при закрытии: живой xterm не сохранить — законченный блок «прервано» без вывода.
  return { ...b, running: false, interrupted: true, exitCode: null, html: null, lines: 0, durationMs: Math.max(0, Date.now() - b.startedAt) }
}

function saveClaude(p: PaneClaude): SavedClaude {
  const s = p.state
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
      items: s.items,
      chain: s.chain,
      epoch: s.epoch,
      edits: s.edits,
    },
  }
}

export function snapshot(): SavedSession {
  const { tabs, active } = useTabs.getState()
  const sessions = useClaudeSessions.getState().sessions
  const panes: Record<string, SavedPane> = {}
  for (const t of tabs) {
    for (const id of leaves(t.tree)) {
      const f = feeds.get(id)?.()
      const r = restored.get(id)
      const c = sessions[id]
      panes[id] = {
        feed: f
          ? f.items.map((it): SavedFeedItem => (it.kind === 'shell' ? saveBlock(it) : { kind: 'claude', id: it.id }))
          : (r?.feed ?? []),
        claudeFrom: f?.claudeFrom ?? r?.claudeFrom ?? 0,
        claudeMode: f?.claudeMode ?? r?.claudeMode ?? false,
        ...(c ? { claude: saveClaude(c) } : {}),
      }
    }
  }
  return { version: SESSION_VERSION, tabs, active, panes }
}

/** JSON снимка не больше `max`: выбрасываются самые старые блоки оболочки (по всем панелям). */
export function serializeCapped(s: SavedSession, max = MAX_SESSION_BYTES): string {
  let text = JSON.stringify(s)
  if (text.length <= max) return text
  const blocks: { pane: string; b: ShellBlock }[] = []
  for (const [pane, p] of Object.entries(s.panes)) {
    for (const it of p.feed) if (it.kind === 'shell') blocks.push({ pane, b: it })
  }
  blocks.sort((x, y) => x.b.startedAt - y.b.startedAt)
  const drop = new Set<ShellBlock>()
  const panes = { ...s.panes }
  while (text.length > max && drop.size < blocks.length) {
    // Порциями: по 10% оставшихся (не меньше одного), чтобы не сериализовать на каждый блок.
    const n = Math.max(1, Math.ceil((blocks.length - drop.size) / 10))
    for (const { b } of blocks.slice(drop.size, drop.size + n)) drop.add(b)
    for (const [pane, p] of Object.entries(s.panes)) panes[pane] = { ...p, feed: p.feed.filter((it) => !(it.kind === 'shell' && drop.has(it))) }
    text = JSON.stringify({ ...s, panes })
  }
  return text
}

let timer: ReturnType<typeof setTimeout> | undefined
let enabled = false

export function scheduleSave(): void {
  if (!enabled) return
  clearTimeout(timer)
  timer = setTimeout(saveNow, SAVE_DELAY_MS)
}

export function saveNow(): Promise<void> {
  clearTimeout(timer)
  timer = undefined
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

/** Недоигранное при закрытии: ответ дописан, действия не идут, вопросы и разрешения сняты. */
function restoreItem(it: FeedClaudeItem): FeedClaudeItem {
  if (it.type === 'assistant' && it.streaming) return { ...it, streaming: false }
  if (it.type === 'action' && it.status === 'running') return { ...it, status: 'error', result: it.result ?? 'Прервано: приложение закрылось' }
  return it
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
    costUsd: num(s.costUsd, 0),
    chain: isRec(s.chain) ? s.chain : null,
    epoch: num(s.epoch, 0),
    items: (Array.isArray(c.state.items) ? c.state.items : []).map(restoreItem),
    edits: isRec(c.state.edits) ? c.state.edits : {},
  }
  state = cancelPrompts(state, undefined, 'exit')
  // id очереди — счётчик этого запуска: восстановленным — свои (отрицательные), без совпадений.
  const queue = (Array.isArray(c.queue) ? c.queue : []).map((m, i) => ({ ...m, id: -(i + 1) }))
  return {
    state,
    procId: null,
    cwd: c.cwd ?? null,
    model: c.model ?? null,
    effort: c.effort ?? null,
    permissionMode: null,
    queue,
    // Очередь не уходит сама после перезапуска: ↵ на пустой строке — следующее.
    paused: queue.length > 0,
    pauseHint: false,
    rewindAt: null,
    closed: c.closed,
    restored: state.sessionId !== null,
  }
}

/** Применяет сохранённую сессию к сторам. Неподходящая (версия, форма) — false, всё как было. */
export function applySession(raw: unknown): boolean {
  if (!isRec(raw) || raw.version !== SESSION_VERSION || !Array.isArray(raw.tabs)) return false
  const tabs = raw.tabs.filter(validTab)
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

/** Загрузка при старте (до первого рендера панелей) и автосохранение изменений. */
export async function restoreSession(): Promise<void> {
  let raw: unknown = null
  try {
    raw = await invoke('session_load')
  } catch {
    raw = null
  }
  applySession(raw)
  enabled = true
  useTabs.subscribe(scheduleSave)
  useClaudeSessions.subscribe(scheduleSave)
}

/** Для тестов: начальное состояние модуля. */
export function resetPersistForTests(): void {
  clearTimeout(timer)
  enabled = false
  feeds.clear()
  restored.clear()
}
