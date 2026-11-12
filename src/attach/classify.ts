// Тип вложения по пути: картинка, PDF, папка, видео/аудио (не уходит), остальное — файл.
import { attachmentId, type AttachKind, type Attachment } from './types'

export const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp']
export const MEDIA_EXT = [
  'mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm', 'wmv', 'flv', 'mpg', 'mpeg', '3gp',
  'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'oga', 'opus', 'aif', 'aiff', 'wma', 'caf',
]
/** Картинка после уменьшения не больше (лимит API на картинку). */
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024
export const PDF_MAX_BYTES = 32 * 1024 * 1024

export const REASON_MEDIA = 'Видео и аудио Claude не принимает'
export const REASON_IMAGE_BIG = 'Картинка больше 5 МБ даже после уменьшения'
export const REASON_PDF_BIG = 'PDF больше 32 МБ'
export const REASON_MISSING = 'Файл не найден'

/** Ответ Rust `attach_inspect` о пути. */
export interface PathInfo {
  path: string
  name: string
  exists: boolean
  isDir: boolean
  size: number
  /** Размер картинки, который уйдёт (после уменьшения длинной стороны до 2000px). */
  preparedSize?: number | null
  width?: number | null
  height?: number | null
  thumb?: string | null
}

export function extOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export const baseName = (path: string) => path.replace(/\/+$/, '').split('/').pop() || path

export function classify(info: Pick<PathInfo, 'name' | 'isDir' | 'size' | 'exists' | 'preparedSize'>): { kind: AttachKind; reason?: string } {
  if (!info.exists) return { kind: 'unsupported', reason: REASON_MISSING }
  if (info.isDir) return { kind: 'folder' }
  const ext = extOf(info.name)
  if (MEDIA_EXT.includes(ext)) return { kind: 'unsupported', reason: REASON_MEDIA }
  if (IMAGE_EXT.includes(ext)) {
    const size = info.preparedSize ?? info.size
    return size > IMAGE_MAX_BYTES ? { kind: 'unsupported', reason: REASON_IMAGE_BIG } : { kind: 'image' }
  }
  if (ext === 'pdf') return info.size > PDF_MAX_BYTES ? { kind: 'unsupported', reason: REASON_PDF_BIG } : { kind: 'pdf' }
  return { kind: 'file' }
}

/** Значок для пути (файл, папка, картинка, pdf). */
export function pathAttachment(info: PathInfo, label?: string): Attachment {
  const { kind, reason } = classify(info)
  const name = info.name || baseName(info.path)
  return {
    id: attachmentId(),
    kind,
    label: label ?? (info.isDir ? `${name}/` : name),
    path: info.path,
    size: info.size,
    ...(info.width ? { width: info.width } : {}),
    ...(info.height ? { height: info.height } : {}),
    ...(info.thumb ? { thumb: info.thumb } : {}),
    ...(reason ? { reason } : {}),
  }
}

/** Значок, который нельзя отправить (неподдерживаемый тип, превышен размер, файла нет). */
export const blocksSend = (t: Attachment) => t.kind === 'unsupported'
