// Значки панели проекта — SVG из макета 07 (полоса инструментов, ветка).

const STROKE = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 } as const

export function FolderIcon() {
  return (
    <svg viewBox="0 0 16 16" {...STROKE}>
      <path d="M1.5 3.5h5l1.5 1.5h6.5v8h-13z" />
    </svg>
  )
}

export function ChangesIcon() {
  return (
    <svg viewBox="0 0 16 16" {...STROKE}>
      <circle cx="8" cy="8" r="2.4" />
      <path d="M1 8h4.6M10.4 8H15" />
    </svg>
  )
}

/** Ветка git: в полосе — 16px штрих 1.4, в кнопке проекта и строке состояния — 12px штрих 1.5. */
export function BranchIcon({ size, strokeWidth = 1.4 }: { size?: number; strokeWidth?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={strokeWidth}>
      <circle cx="4" cy="3.5" r="1.7" />
      <circle cx="4" cy="12.5" r="1.7" />
      <circle cx="12" cy="5.5" r="1.7" />
      <path d="M4 5.2v5.6M12 7.2c0 3-4 2.5-7.4 4" />
    </svg>
  )
}
