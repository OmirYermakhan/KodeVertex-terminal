// Вложения ↔ Rust: что за путь (тип, размер, миниатюра), картинка из буфера, диалог файлов.
// Сами файлы webview не читает: base64 и уменьшение картинок — в Rust при отправке.
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { pathAttachment, type PathInfo } from './classify'
import type { Attachment } from './types'

export const SCREENSHOT_LABEL = 'скрин'

export function inspectPaths(paths: string[]): Promise<PathInfo[]> {
  if (paths.length === 0) return Promise.resolve([])
  return invoke<PathInfo[]>('attach_inspect', { paths })
}

/** Значки для путей (файлы из Finder, диалога, `@`). */
export async function attachPaths(paths: string[]): Promise<Attachment[]> {
  const infos = await inspectPaths(paths)
  return infos.map((i) => pathAttachment(i))
}

/** ⌘V с картинкой: Rust сохраняет её PNG в attachments/ и отдаёт сведения; null — картинки нет. */
export function pasteClipboardImage(): Promise<PathInfo | null> {
  return invoke<PathInfo | null>('attach_clipboard_image')
}

/** «скрин», «скрин 2», … — по числу скринов, уже стоящих в сообщении. */
export function screenshotLabel(existing: readonly Attachment[]): string {
  const n = existing.filter((t) => t.kind === 'image' && new RegExp(`^${SCREENSHOT_LABEL}( \\d+)?$`).test(t.label)).length + 1
  return n === 1 ? SCREENSHOT_LABEL : `${SCREENSHOT_LABEL} ${n}`
}

/** Скрепка / ⌘O: системный диалог выбора файлов (несколько). Отмена — []. */
export async function pickFiles(): Promise<string[]> {
  const r = await open({ multiple: true, directory: false, title: 'Вложить в сообщение' })
  if (!r) return []
  return Array.isArray(r) ? r : [r]
}
