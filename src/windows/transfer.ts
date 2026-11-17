// Перенос вкладки между окнами — живой: оболочка, идущая команда и процесс Claude не перезапускаются.
// Окно-источник отсоединяет PTY и claude (pty_detach / claude_detach), снимает ленты, раскладку и
// экран xterm, убирает вкладку (без автосоздания новой) и отдаёт её новому окну (window_open) или
// существующему (window_send_tab → событие `tab://receive`). Приёмник кладёт вкладку в сторы,
// TerminalPane подключается к живому PTY (pty_attach), сессия Claude — к живому процессу
// (claude_attach). Окно, отдавшее последнюю вкладку, закрывается.
//
// Публичный API (для перетаскивания вкладок в TabBar):
//   canMoveToNewWindow(): Promise<boolean>
//       — можно ли вынести вкладку в новое окно: false, если это единственная вкладка
//         единственного окна (жест ничего не делает).
//   moveTabToNewWindow(tabId, screenX, screenY): Promise<boolean>
//       — вынести вкладку в новое окно; x, y — экранные логические координаты курсора
//         (e.screenX / e.screenY), полоса вкладок нового окна окажется под курсором.
//   moveTabToWindow(tabId, targetLabel): Promise<boolean>
//       — перенести вкладку в другое окно (метка — из windowAt), оно получит фокус.
//   windowAt(screenX, screenY): Promise<string | null>
//       — метка другого окна приложения под точкой экрана (null — нет).
//   true — вкладка уехала; false — перенос не удался или нечего переносить (вкладка осталась здесь).
// Низкоуровневое (тесты, запуск окна): detachTab, adoptTab, bootWindow.
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { leaves } from '../layout/paneTree'
import { useTabs, type Tab } from '../layout/tabsStore'
import { adoptClaude, detachClaude, useClaudeSessions, type PaneClaude } from '../claude/sessionStore'
import { applySession, enableAutosave, restoreSession, restoredClaude, snapshotPanes, stageTransferredPane, stopAutosave, type SavedPane, type SavedSession } from '../persist/session'
import { detachPty, killPty } from '../terminal/ptyClient'
import { clearMoving, liveSource, markMoving, offerLive, type LivePane } from './livePanes'
import { logError } from '../diag/log'

export type { LivePane }

export interface TransferPane {
  /** Лента (блоки как есть, идущий — идущим), граница ⌃L, режим строки, Claude в формате файла. */
  saved: SavedPane
  /** Живой PTY панели (нет — панель не была смонтирована или PTY не отсоединился: новая оболочка). */
  live?: LivePane
  /** Живой процесс claude панели. */
  claudeProcId?: string
  /**
   * Сессия Claude целиком (идущий ход, агенты, вопросы) — когда процесс переехал живым или его
   * нет и ход не идёт. Иначе приёмник берёт saved.claude, как после перезапуска.
   */
  claude?: PaneClaude
}

export interface TabTransfer {
  tab: Tab
  panes: Record<string, TransferPane>
}

/** Payload нового окна (window_open → window_take_init) и события `tab://receive`. */
export type WindowInit = { kind: 'transfer'; tab: TabTransfer } | { kind: 'restore'; session: SavedSession } | null

export const RECEIVE_EVENT = 'tab://receive'

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function isTransfer(v: unknown): v is { kind: 'transfer'; tab: TabTransfer } {
  if (!isRec(v) || v.kind !== 'transfer' || !isRec(v.tab)) return false
  const t = v.tab
  return isRec(t.tab) && typeof t.tab.id === 'string' && isRec(t.tab.tree) && isRec(t.panes)
}

/** Метка этого окна; вне Tauri — 'main'. */
export function windowLabel(): string {
  try {
    return getCurrentWindow().label
  } catch {
    return 'main'
  }
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0))

/** Ждать размонтирования панелей (их источник живого состояния снят), не дольше ~1 с. */
async function unmounted(ids: readonly string[]): Promise<void> {
  for (let i = 0; i < 60 && ids.some((id) => liveSource(id)); i++) await new Promise((r) => setTimeout(r, 16))
}

/**
 * Отсоединить вкладку от этого окна: процессы её панелей отсоединены (не убиты), панели помечены
 * «переезжают», вкладка убрана из стора без автосоздания новой. Возвращает всё для приёмника.
 */
export async function detachTab(tabId: string): Promise<TabTransfer> {
  const tab = useTabs.getState().tabs.find((t) => t.id === tabId)
  if (!tab) throw new Error(`нет вкладки ${tabId}`)
  const ids = leaves(tab.tree)
  // Сначала отсоединить процессы: дальше их вывод копится в Rust и не потеряется между снимком и подключением.
  const detached = await Promise.all(
    ids.map(async (id) => {
      const claudeProcId = await detachClaude(id)
      const src = liveSource(id)
      const ptyId = src?.ptyId() ?? null
      let pty = false
      if (ptyId !== null) {
        try {
          await detachPty(ptyId)
          pty = true
        } catch (e) {
          // Старая сборка без detach: оболочка не переедет — в приёмнике будет новая.
          logError('transfer', `pty_detach: ${String(e)}`)
          killPty(ptyId)
        }
      }
      return { id, claudeProcId, pty }
    }),
  )
  // Вывод, отправленный до отсоединения, ещё может быть в пути по каналам.
  await tick()
  const live = new Map<string, LivePane>()
  for (const d of detached) {
    if (!d.pty) continue
    const l = await liveSource(d.id)?.capture()
    if (l) live.set(d.id, l)
  }
  const saved = snapshotPanes([tab], { live: true })
  const sessions = useClaudeSessions.getState().sessions
  const panes: Record<string, TransferPane> = {}
  for (const d of detached) {
    const c = sessions[d.id]
    const full = c && (d.claudeProcId !== null || !c.state.busy)
    panes[d.id] = {
      saved: saved[d.id] ?? { feed: [], claudeFrom: 0, claudeMode: false },
      ...(live.has(d.id) ? { live: live.get(d.id) } : {}),
      ...(d.claudeProcId !== null ? { claudeProcId: d.claudeProcId } : {}),
      ...(full ? { claude: { ...c, procId: d.claudeProcId } } : {}),
    }
  }
  // Размонтирование панелей (вкладка убрана) не убивает отсоединённое.
  for (const id of ids) markMoving(id)
  useTabs.getState().takeTab(tabId)
  return { tab, panes }
}

/**
 * Принять вкладку (из другого окна или обратно после неудачного переноса): ленты, живые PTY и
 * сессии Claude ждут монтирования панелей; вкладка — в конец полосы и активная.
 */
export function adoptTab(t: TabTransfer): void {
  if (useTabs.getState().tabs.some((x) => x.id === t.tab.id)) {
    useTabs.getState().activate(t.tab.id)
    return
  }
  for (const id of leaves(t.tab.tree)) {
    const p = t.panes[id]
    clearMoving(id)
    if (!p) continue
    stageTransferredPane(id, p.saved)
    if (p.live) offerLive(id, p.live)
    if (p.claude) adoptClaude(id, p.claude, p.claudeProcId ?? null)
    else if (p.saved.claude) adoptClaude(id, restoredClaude(p.saved.claude), null)
  }
  useTabs.getState().putTab(t.tab)
}

/** Вкладок не осталось (последняя уехала) — окно закрывается. */
function closeIfEmpty(): void {
  if (useTabs.getState().tabs.length > 0) return
  stopAutosave()
  getCurrentWindow()
    .close()
    .catch((e: unknown) => logError('transfer', `закрытие окна: ${String(e)}`))
}

/** Вынести можно, если есть что отделять: не единственная вкладка единственного окна. */
export async function canMoveToNewWindow(): Promise<boolean> {
  if (useTabs.getState().tabs.length > 1) return true
  try {
    return (await invoke<number>('window_count')) > 1
  } catch {
    return false
  }
}

/** Метка другого окна приложения под точкой экрана (логические координаты); null — нет. */
export async function windowAt(screenX: number, screenY: number): Promise<string | null> {
  try {
    return (await invoke<string | null>('window_at', { x: screenX, y: screenY })) ?? null
  } catch {
    return null
  }
}

async function send(tabId: string, deliver: (payload: WindowInit) => Promise<unknown>): Promise<boolean> {
  let t: TabTransfer
  try {
    t = await detachTab(tabId)
  } catch (e) {
    logError('transfer', String(e))
    return false
  }
  try {
    await deliver({ kind: 'transfer', tab: t })
  } catch (e) {
    // Приёмника нет — вкладка возвращается сюда (процессы ещё отсоединены — подключаемся снова),
    // когда её прежние панели размонтированы: иначе React оставил бы их со старыми каналами.
    logError('transfer', `вкладка не передана: ${String(e)}`)
    await unmounted(leaves(t.tab.tree))
    adoptTab(t)
    return false
  }
  closeIfEmpty()
  return true
}

/** Вкладка — в новое окно, его полоса вкладок под курсором (x, y — экранные логические). */
export async function moveTabToNewWindow(tabId: string, screenX: number, screenY: number): Promise<boolean> {
  if (!(await canMoveToNewWindow())) return false
  return send(tabId, (payload) => invoke<string>('window_open', { payload, x: screenX, y: screenY }))
}

/** Вкладка — в существующее окно targetLabel (оно станет активным и получит фокус). */
export async function moveTabToWindow(tabId: string, targetLabel: string): Promise<boolean> {
  if (targetLabel === windowLabel()) return false
  return send(tabId, (payload) => invoke('window_send_tab', { target: targetLabel, payload }))
}

/**
 * Запуск окна до первого рендера. `main` — сессия из файла (Rust сам откроет остальные окна).
 * Другое окно — своё из window_take_init: перенесённая вкладка (единственная), сохранённая часть
 * сессии или ничего (одна новая вкладка). Во всех окнах — приём вкладок из других окон.
 */
export async function bootWindow(): Promise<void> {
  const label = windowLabel()
  if (label === 'main') await restoreSession()
  else {
    let init: unknown = null
    try {
      init = await invoke('window_take_init')
    } catch {
      init = null
    }
    if (isTransfer(init)) {
      useTabs.setState({ tabs: [], active: '', respawns: [] })
      adoptTab(init.tab)
    } else if (isRec(init) && init.kind === 'restore') applySession(init.session)
    enableAutosave()
  }
  try {
    // Слушатель этого окна (не глобальный): событие адресовано метке окна-приёмника.
    await getCurrentWindow().listen<unknown>(RECEIVE_EVENT, (e) => {
      if (isTransfer(e.payload)) adoptTab(e.payload.tab)
    })
  } catch {
    // вне Tauri
  }
}
