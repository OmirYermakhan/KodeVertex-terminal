// Файлы из Finder над окном: Tauri отдаёт настоящие пути (событие drag-drop вебвью). Над какой
// панелью курсор — та показывает оверлей «Отпустите, чтобы вставить…» и получает пути.
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { create } from 'zustand'

export interface DropState {
  /** Панель под курсором (data-pane-id); null — перетаскивания нет. */
  paneId: string | null
  paths: string[]
}

export const useDrop = create<DropState>(() => ({ paneId: null, paths: [] }))

/** Число значков в строке ввода панелей — сегмент «вложения N» статус-бара. */
export const useAttachCount = create<{ counts: Record<string, number> }>(() => ({ counts: {} }))

export function setAttachCount(paneId: string, n: number): void {
  useAttachCount.setState((s) => (s.counts[paneId] === n ? s : { counts: { ...s.counts, [paneId]: n } }))
}

type DropHandler = (paths: string[]) => void
const handlers = new Map<string, DropHandler>()

/** Панель принимает брошенные файлы (вставка у курсора строки ввода). */
export function registerDropTarget(paneId: string, h: DropHandler): () => void {
  handlers.set(paneId, h)
  return () => {
    if (handlers.get(paneId) === h) handlers.delete(paneId)
  }
}

/** Панель под точкой окна (CSS-пиксели); иначе — fallback (панель в фокусе). */
export function paneAt(x: number, y: number, fallback: string | null): string | null {
  const el = typeof document.elementFromPoint === 'function' ? document.elementFromPoint(x, y) : null
  const id = el?.closest<HTMLElement>('[data-pane-id]')?.dataset.paneId
  return id && handlers.has(id) ? id : fallback && handlers.has(fallback) ? fallback : null
}

/** Событие перетаскивания (как payload Tauri; position — физические пиксели). */
export type DragEvent =
  | { type: 'enter'; paths: string[]; position: { x: number; y: number } }
  | { type: 'over'; position: { x: number; y: number } }
  | { type: 'drop'; paths: string[]; position: { x: number; y: number } }
  | { type: 'leave' }

export function handleDragEvent(ev: DragEvent, focused: () => string | null): void {
  if (ev.type === 'leave') {
    useDrop.setState({ paneId: null, paths: [] })
    return
  }
  const scale = window.devicePixelRatio || 1
  const pane = paneAt(ev.position.x / scale, ev.position.y / scale, focused())
  if (ev.type === 'enter') {
    useDrop.setState({ paneId: pane, paths: ev.paths })
    return
  }
  if (ev.type === 'over') {
    if (useDrop.getState().paneId !== pane) useDrop.setState({ paneId: pane })
    return
  }
  const paths = ev.paths.length > 0 ? ev.paths : useDrop.getState().paths
  useDrop.setState({ paneId: null, paths: [] })
  if (pane && paths.length > 0) handlers.get(pane)?.(paths)
}

/** Подписка на перетаскивание файлов в окно (один раз на приложение). */
export function installDragDrop(focused: () => string | null): () => void {
  let un: (() => void) | null = null
  let dead = false
  try {
    getCurrentWebview()
      .onDragDropEvent((e) => handleDragEvent(e.payload as DragEvent, focused))
      .then((f) => {
        if (dead) f()
        else un = f
      })
      .catch(() => {})
  } catch {
    // Вне Tauri (тесты, стенд) вебвью нет.
  }
  return () => {
    dead = true
    un?.()
  }
}

/** Подпись оверлея: «mockup.pdf и ещё 2 · встанут туда, где курсор». */
export function dropSubline(paths: string[]): string {
  if (paths.length === 0) return 'встанут туда, где курсор'
  const name = paths[0].replace(/\/+$/, '').split('/').pop() || paths[0]
  return paths.length === 1 ? `${name} · встанет туда, где курсор` : `${name} и ещё ${paths.length - 1} · встанут туда, где курсор`
}

export const DROP_TITLE = 'Отпустите, чтобы вставить в сообщение'
export const DROP_TITLE_SHELL = 'Отпустите, чтобы вставить путь'
export const DROP_TITLE_SHELL_MANY = 'Отпустите, чтобы вставить пути'
