// Данные мини-просмотра из Rust (src-tauri/src/preview.rs): окно текста, первые записи папки,
// уменьшенная картинка, страница PDF. Webview файл целиком не читает.
import { invoke } from '@tauri-apps/api/core'
import { classify } from '../classify'
import type { Attachment } from '../types'

export type TextData =
  | { kind: 'text'; start: number; lines: string[]; total: number | null; size: number }
  | { kind: 'binary'; size: number }
  | { kind: 'error'; message: string }

export interface DirEntryData {
  name: string
  isDir: boolean
  size: number | null
  count: number | null
}
export type DirData = { kind: 'dir'; entries: DirEntryData[]; total: number } | { kind: 'error'; message: string }

export interface ImageData {
  width: number
  height: number
  size: number
  src: string
}

export interface PdfData {
  pages: number
  page: number
  size: number
  src: string
}

export type PreviewData =
  | TextData
  | DirData
  | ({ kind: 'image' } & ImageData)
  | ({ kind: 'pdf' } & PdfData)

/** Ширина картинки в карточке ×2 (Retina). */
export const IMAGE_PREVIEW_PX = 600
/** Полный размер (↵ целиком): уменьшенная копия, не оригинал. */
export const IMAGE_FULL_PX = 2400
export const PDF_PREVIEW_PX = 560

/** Повторное наведение не перечитывает файл (короткое окно: файл мог измениться). */
const CACHE_MS = 4000
const cache = new Map<string, { at: number; p: Promise<PreviewData> }>()

function cached(key: string, load: () => Promise<PreviewData>): Promise<PreviewData> {
  const now = Date.now()
  const hit = cache.get(key)
  if (hit && now - hit.at < CACHE_MS) return hit.p
  const p = load().catch((e: unknown): PreviewData => ({ kind: 'error', message: String(e) }))
  cache.set(key, { at: now, p })
  if (cache.size > 64) cache.delete(cache.keys().next().value!)
  return p
}

export const clearPreviewCache = () => cache.clear()

/** Нужна ли значку загрузка (блок, сообщение, неподдерживаемое — всё уже в значке). */
export function needsLoad(t: Attachment): boolean {
  return !!t.path && (t.kind === 'file' || t.kind === 'image' || t.kind === 'folder' || t.kind === 'pdf')
}

export function loadPreview(t: Attachment, page = 1): Promise<PreviewData> | null {
  const path = t.path
  if (!path || !needsLoad(t)) return null
  switch (t.kind) {
    case 'image':
      return cached(`i:${path}`, () => invoke<ImageData>('preview_image', { path, max: IMAGE_PREVIEW_PX }).then((d) => ({ kind: 'image', ...d })))
    case 'pdf':
      return cached(`p:${path}:${page}`, () =>
        invoke<PdfData>('preview_pdf', { path, page, width: PDF_PREVIEW_PX }).then((d) => ({ kind: 'pdf', ...d })),
      )
    case 'folder':
      return cached(`d:${path}`, () => invoke<DirData>('preview_dir', { path }))
    default:
      return cached(`t:${path}:${t.line ?? ''}`, () => invoke<TextData>('preview_text', { path, line: t.line ?? null }))
  }
}

export function loadFullImage(path: string): Promise<ImageData> {
  return invoke<ImageData>('preview_image', { path, max: IMAGE_FULL_PX })
}

export type OpenHow = 'default' | 'editor' | 'reveal'

export function openPath(path: string, how: OpenHow, line?: number): Promise<void> {
  return invoke<void>('preview_open', { path, how, line: line ?? null })
}

/** Тип по имени без сведений из Rust (боковой просмотр в `@`). */
export const quickKind = (name: string, isDir: boolean): Attachment['kind'] => classify({ name, isDir, size: 0, exists: true }).kind
