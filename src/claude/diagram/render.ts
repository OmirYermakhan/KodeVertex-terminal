// Отрисовка блоков ```mermaid в картинку.
// Безопасность: securityLevel 'strict', htmlLabels false, а готовый SVG показывается только как
// <img src="blob:…"> — в такой картинке скрипты и ссылки не работают вообще, в DOM SVG не попадает.
// mermaid грузится лениво (import()) — отдельный чанк, только при первой схеме.
import type { MermaidConfig } from 'mermaid'
import { THEMES, type ThemeId } from '../../theme/themes'

export type DiagramResult = { ok: true; url: string } | { ok: false; error: string }

type Mermaid = (typeof import('mermaid'))['default']

const CACHE_LIMIT = 100
/** Шрифт системный: внешние шрифты внутри <img> не загружаются. */
const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif'

const cache = new Map<string, DiagramResult>()
let lib: Promise<Mermaid> | undefined
let initedTheme: ThemeId | undefined
/** mermaid не реентерабелен — все вызовы идут по очереди. */
let queue: Promise<unknown> = Promise.resolve()
let seq = 0

function config(themeId: ThemeId): MermaidConfig {
  const theme = THEMES[themeId]
  const t = theme.tokens
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    htmlLabels: false,
    theme: 'base',
    fontFamily: FONT,
    themeVariables: {
      darkMode: theme.dark,
      background: t.bg,
      primaryColor: t.panel2,
      primaryTextColor: t.text,
      primaryBorderColor: t.rule,
      lineColor: t.muted,
      secondaryColor: t.panel,
      tertiaryColor: t.bg,
      fontFamily: FONT,
    },
  }
}

/** У корня SVG от mermaid width="100%": в <img> схема растягивалась бы на всю ширину.
 *  Ставим настоящий размер из viewBox — шире карточки её ужмёт CSS (max-width: 100%). */
function fixSize(svg: string): string {
  return svg.replace(/<svg\b[^>]*>/, (tag) => {
    const vb = /viewBox="[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)"/.exec(tag)
    if (!vb) return tag
    const sized = tag.replace(/\s(width|height)="[^"]*"/g, '')
    return sized.replace(/^<svg\b/, `<svg width="${vb[1]}" height="${vb[2]}"`)
  })
}

function remember(key: string, res: DiagramResult): void {
  cache.set(key, res)
  while (cache.size > CACHE_LIMIT) {
    const [oldKey, old] = cache.entries().next().value as [string, DiagramResult]
    cache.delete(oldKey)
    if (old.ok) URL.revokeObjectURL(old.url)
  }
}

async function draw(src: string, themeId: ThemeId): Promise<DiagramResult> {
  lib ??= import('mermaid').then((m) => m.default)
  const mermaid = await lib
  if (initedTheme !== themeId) {
    mermaid.initialize(config(themeId))
    initedTheme = themeId
  }
  const id = `kv-dg-${++seq}`
  try {
    const { svg } = await mermaid.render(id, src)
    return { ok: true, url: URL.createObjectURL(new Blob([fixSize(svg)], { type: 'image/svg+xml' })) }
  } catch (e) {
    // При ошибке mermaid может оставить временный элемент для замеров.
    document.getElementById(`d${id}`)?.remove()
    document.getElementById(id)?.remove()
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Готовый результат из кэша — чтобы повторная отрисовка ленты не мигала «Схема рисуется…». */
export function cachedDiagram(src: string, themeId: ThemeId): DiagramResult | undefined {
  return cache.get(`${themeId}\n${src}`)
}

export function renderDiagram(src: string, themeId: ThemeId): Promise<DiagramResult> {
  const key = `${themeId}\n${src}`
  const hit = cache.get(key)
  if (hit) return Promise.resolve(hit)
  const job = queue.then(async () => {
    // Пока ждали очереди, ту же схему мог нарисовать другой вызов.
    const again = cache.get(key)
    if (again) return again
    try {
      const res = await draw(src, themeId)
      remember(key, res)
      return res
    } catch (e) {
      // Не загрузилась сама библиотека — не кэшируем, в следующий раз попробуем снова.
      lib = undefined
      return { ok: false, error: String(e) } satisfies DiagramResult
    }
  })
  queue = job
  return job
}

/** Для тестов: сбросить кэш и тему. */
export function resetDiagramCache(): void {
  for (const r of cache.values()) if (r.ok) URL.revokeObjectURL(r.url)
  cache.clear()
  initedTheme = undefined
}
