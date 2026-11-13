// Размеры карточек мини-просмотра (макет 06).
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
