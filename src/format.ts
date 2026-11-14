/** Стоимость в долларах: «$0.42», мелкие суммы — с тремя знаками. */
export function formatCost(usd: number): string {
  if (usd > 0 && usd < 0.01) return `$${usd.toFixed(3)}`
  return `$${usd.toFixed(2)}`
}

/** Размер файла: «512 Б», «2.0 КБ», «1.5 МБ». */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`
}
