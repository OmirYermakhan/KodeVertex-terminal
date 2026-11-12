// Вид значка вложения (макет 06-attachments `.tk`): одна разметка для строки ввода (DOM строится
// вручную — поле contenteditable) и для пузыря «Вы» (React). Цвета — переменные темы --tk*.
import { memo, type MouseEvent } from 'react'
import { extOf } from './classify'
import type { Attachment } from './types'

const ICONS = {
  code: 'M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5',
  dir: 'M1.8 4.2c0-.6.4-1 1-1h3.4l1.4 1.6h5.6c.6 0 1 .4 1 1v6.8c0 .6-.4 1-1 1H2.8c-.6 0-1-.4-1-1z',
  doc: 'M4 1.8h5.2L12.5 5v9.2H4zM9 1.8V5.2h3.4',
  warn: 'M8 2 14.5 13.5h-13z M8 6.5v3.2 M8 11.4v.2',
  term: 'M3 4.5 6.5 8 3 11.5M8 11.5h5',
  ai: 'M8 1.8 9.4 6.6 14.2 8 9.4 9.4 8 14.2 6.6 9.4 1.8 8 6.6 6.6z',
} as const
export type IconName = keyof typeof ICONS
/** Скрепка (кнопка слева в строке ввода). */
export const CLIP_PATH = 'M10.5 4.5 5.4 9.6a1.4 1.4 0 0 0 2 2l5.3-5.3a2.8 2.8 0 0 0-4-4L3.4 7.6a4.2 4.2 0 0 0 6 6l4.1-4.1'
/** Стрелка «внутрь» оверлея перетаскивания. */
export const DROP_PATH = 'M12 3v12m0 0-4.5-4.5M12 15l4.5-4.5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4'

const STROKE: Record<IconName, number> = { code: 1.4, dir: 1.3, doc: 1.3, warn: 1.4, term: 1.5, ai: 1.3 }

const CODE_EXT = new Set(
  'ts tsx js jsx mjs cjs json rs py go rb java kt swift c h cc cpp hpp cs php css scss less html htm vue svelte md mdx yml yaml toml sh zsh bash sql xml txt lua dart ex exs erl hs ml scala r jl ini cfg conf env lock gradle'.split(' '),
)

export function iconOf(t: Attachment): IconName {
  switch (t.kind) {
    case 'folder':
      return 'dir'
    case 'block':
      return 'term'
    case 'message':
      return 'ai'
    case 'unsupported':
      return 'warn'
    case 'pdf':
      return 'doc'
    default:
      return CODE_EXT.has(extOf(t.label.replace(/:\d+$/, ''))) ? 'code' : 'doc'
  }
}

/** Приглушённая часть подписи: `:42` у строки файла, `· 1` у упавшей команды. */
export function mutedOf(t: Attachment): string | null {
  if (t.line) return `:${t.line}`
  if (t.kind === 'block' && t.block && t.block.exitCode !== null && t.block.exitCode !== 0) return `· ${t.block.exitCode}`
  return null
}

export function tokenClass(t: Attachment, selected = false): string {
  const failed = t.kind === 'block' && t.block !== undefined && t.block.exitCode !== null && t.block.exitCode !== 0
  const kind = t.kind === 'block' ? (failed ? ' blkt fail' : ' blkt') : t.kind === 'message' ? ' msg' : t.kind === 'unsupported' ? ' err' : ''
  return 'tk' + kind + (selected ? ' sel' : '')
}

/** Подсказка при наведении там, где мини-просмотра нет (очередь): причина или путь. */
export function tokenTitle(t: Attachment): string {
  if (t.reason) return `${t.label} — ${t.reason}`
  if (t.path) return t.path
  if (t.block) return t.block.command
  return t.label
}

const SVG_NS = 'http://www.w3.org/2000/svg'

/** DOM значка для поля ввода (contenteditable=false: значок ведёт себя как одна буква). */
export function tokenElement(t: Attachment, selected = false, title = true): HTMLSpanElement {
  const el = document.createElement('span')
  el.className = tokenClass(t, selected)
  el.setAttribute('contenteditable', 'false')
  el.dataset.tk = t.id
  // С мини-просмотром подсказка title не нужна (она легла бы поверх карточки).
  if (title) el.title = tokenTitle(t)
  if (t.kind === 'image') {
    const mini = document.createElement('span')
    mini.className = t.thumb ? 'mini pic' : 'mini'
    if (t.thumb) mini.style.backgroundImage = `url("${t.thumb}")`
    el.appendChild(mini)
  } else {
    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('class', 'ico')
    svg.setAttribute('viewBox', '0 0 16 16')
    const path = document.createElementNS(SVG_NS, 'path')
    const icon = iconOf(t)
    path.setAttribute('d', ICONS[icon])
    path.setAttribute('fill', 'none')
    path.setAttribute('stroke', 'currentColor')
    path.setAttribute('stroke-width', String(STROKE[icon]))
    path.setAttribute('stroke-linecap', 'round')
    path.setAttribute('stroke-linejoin', 'round')
    svg.appendChild(path)
    el.appendChild(svg)
  }
  el.appendChild(document.createTextNode(t.label))
  const mut = mutedOf(t)
  if (mut) {
    if (t.kind === 'block') el.appendChild(document.createTextNode(' '))
    const m = document.createElement('span')
    m.className = 'mut'
    m.textContent = mut
    el.appendChild(m)
  }
  return el
}

export function Icon({ name, className = 'ico' }: { name: IconName; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden="true">
      <path d={ICONS[name]} fill="none" stroke="currentColor" strokeWidth={STROKE[name]} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export interface TokenProps {
  token: Attachment
  selected?: boolean
  /**
   * Мини-просмотр (часть B): наведение на значок. Пока не задан — только подсказка title.
   * el — элемент значка (якорь всплывающего просмотра).
   */
  onPreview?(token: Attachment, el: HTMLElement | null): void
}

/** Значок в тексте отправленного сообщения или строки очереди. */
export const Token = memo(function Token({ token: t, selected, onPreview }: TokenProps) {
  const mut = mutedOf(t)
  return (
    <span
      className={tokenClass(t, selected)}
      data-tk={t.id}
      title={onPreview ? undefined : tokenTitle(t)}
      onMouseEnter={onPreview ? (e: MouseEvent<HTMLSpanElement>) => onPreview(t, e.currentTarget) : undefined}
      onMouseLeave={onPreview ? () => onPreview(t, null) : undefined}
    >
      {t.kind === 'image' ? <span className={t.thumb ? 'mini pic' : 'mini'} style={t.thumb ? { backgroundImage: `url("${t.thumb}")` } : undefined} /> : <Icon name={iconOf(t)} />}
      {t.label}
      {mut && (
        <>
          {t.kind === 'block' ? ' ' : ''}
          <span className="mut">{mut}</span>
        </>
      )}
    </span>
  )
})
