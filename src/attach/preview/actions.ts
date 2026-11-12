// Что делают клавиши в мини-просмотре (макет 06, лист клавиш «Значок в тексте»): ↵ — главное
// действие типа, ⌘↵ — в редакторе, ⌫ — убрать значок (только в строке ввода), ←/→ — страницы PDF.
import type { Attachment } from '../types'
import type { OpenHow, PreviewData } from './api'

export type PreviewAction =
  | { type: 'overlay'; path: string; label: string }
  | { type: 'open'; how: OpenHow; path: string; line?: number }
  | { type: 'jump'; id: string; kind: 'block' | 'message' }
  | { type: 'remove'; id: string }
  | { type: 'page'; delta: -1 | 1 }
  | { type: 'close' }

export type PreviewFrom = 'input' | 'bubble'

const isText = (d: PreviewData | null) => d?.kind === 'text'

/** ↵ — главное действие значка; null — нечего делать. */
export function enterAction(t: Attachment): PreviewAction | null {
  const path = t.path
  switch (t.kind) {
    case 'image':
      return path ? { type: 'overlay', path, label: t.label } : null
    case 'file':
    case 'pdf':
      return path ? { type: 'open', how: 'default', path, ...(t.line ? { line: t.line } : {}) } : null
    case 'folder':
      return path ? { type: 'open', how: 'reveal', path } : null
    case 'block':
    case 'message':
      return t.source ? { type: 'jump', id: t.source, kind: t.kind } : null
    case 'unsupported':
      return null
  }
}

/** ⌘↵ — текстовый файл в редакторе ($VISUAL / code). */
export function editorAction(t: Attachment, data: PreviewData | null): PreviewAction | null {
  if (t.kind !== 'file' || !t.path || (data && !isText(data))) return null
  return { type: 'open', how: 'editor', path: t.path, ...(t.line ? { line: t.line } : {}) }
}

export interface KeyLikePv {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

/** Действие для клавиши в открытом просмотре; null — клавиша не его. */
export function keyAction(t: Attachment, data: PreviewData | null, from: PreviewFrom, e: KeyLikePv): PreviewAction | null {
  const plain = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey
  const metaOnly = e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey
  if (e.key === 'Escape' && plain) return { type: 'close' }
  if (e.key === 'Enter' && plain) return enterAction(t)
  if (e.key === 'Enter' && metaOnly) return editorAction(t, data)
  if (e.key === 'Backspace' && plain && from === 'input') return { type: 'remove', id: t.id }
  if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && plain && data?.kind === 'pdf' && data.pages > 1) {
    return { type: 'page', delta: e.key === 'ArrowLeft' ? -1 : 1 }
  }
  return null
}

/** Подсказка главного действия в подвале карточки (как в макете). */
export function enterHint(t: Attachment, data: PreviewData | null): string | null {
  switch (t.kind) {
    case 'image':
      return '↵ целиком'
    case 'file':
      return data && !isText(data) ? '↵ открыть' : '↵ открыть · ⌘↵ в редакторе'
    case 'pdf':
      return data?.kind === 'pdf' && data.pages > 1 ? '← → страницы · ↵ открыть' : '↵ открыть'
    case 'folder':
      return '↵ в Finder'
    case 'block':
      return t.source ? '↵ к блоку' : null
    case 'message':
      return t.source ? '↵ к сообщению' : null
    case 'unsupported':
      return null
  }
}
