/** Стоимость в долларах: «$0.42», мелкие суммы — с тремя знаками. */
export function formatCost(usd: number): string {
  if (usd > 0 && usd < 0.01) return `$${usd.toFixed(3)}`
  return `$${usd.toFixed(2)}`
}
