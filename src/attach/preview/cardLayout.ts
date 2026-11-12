// Размеры карточек мини-просмотра (макет 06) и значки записей папки.
import { extOf } from '../classify'
import { iconOf, type IconName } from '../tokenView'
import type { Attachment } from '../types'

export type PreviewVariant = 'card' | 'bubble' | 'side'

export const CARD_WIDTH = 300
/** Код со строкой (сцена Б) — шире: строки длиннее. */
export const CODE_LINE_WIDTH = 330
export const BUBBLE_WIDTH = 210
export const SIDE_WIDTH = 220
/** Строк вывода блока в просмотре. */
export const BLOCK_TAIL = 6
export const SIDE_LINES = 3
export const NAME_PAD = 17

export function cardWidth(t: Attachment, variant: PreviewVariant): number {
  if (variant === 'side') return SIDE_WIDTH
  if (variant === 'bubble' && t.kind === 'image') return BUBBLE_WIDTH
  return t.kind === 'file' && t.line ? CODE_LINE_WIDTH : CARD_WIDTH
}

export function entryIcon(name: string, isDir: boolean): [IconName, string] {
  if (isDir) return ['dir', 'ico dir']
  if (extOf(name) === 'pdf') return ['doc', 'ico pdf']
  const i = iconOf({ id: '', kind: 'file', label: name })
  return [i, i === 'code' ? 'ico code' : 'ico']
}

