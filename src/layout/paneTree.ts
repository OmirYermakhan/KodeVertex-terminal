export type Dir = 'left' | 'right' | 'up' | 'down'
export type PaneNode =
  | { kind: 'leaf'; id: string }
  | { kind: 'split'; axis: 'row' | 'col'; ratio: number; a: PaneNode; b: PaneNode }
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export const leaf = (id: string): PaneNode => ({ kind: 'leaf', id })

/** Новая панель появляется справа (row) или снизу (col). */
export function splitPane(t: PaneNode, target: string, axis: 'row' | 'col', newId: string): PaneNode {
  if (t.kind === 'leaf') {
    return t.id === target ? { kind: 'split', axis, ratio: 0.5, a: t, b: leaf(newId) } : t
  }
  return { ...t, a: splitPane(t.a, target, axis, newId), b: splitPane(t.b, target, axis, newId) }
}

/** null — дерево опустело. */
export function closePane(t: PaneNode, target: string): PaneNode | null {
  if (t.kind === 'leaf') return t.id === target ? null : t
  const a = closePane(t.a, target)
  const b = closePane(t.b, target)
  if (a === null) return b
  if (b === null) return a
  return { ...t, a, b }
}

export function layoutRects(t: PaneNode, r: Rect = { x: 0, y: 0, w: 1, h: 1 }): Record<string, Rect> {
  if (t.kind === 'leaf') return { [t.id]: r }
  const [ra, rb] = childRects(t, r)
  return { ...layoutRects(t.a, ra), ...layoutRects(t.b, rb) }
}

export function childRects(t: Extract<PaneNode, { kind: 'split' }>, r: Rect): [Rect, Rect] {
  if (t.axis === 'row') {
    const wa = r.w * t.ratio
    return [{ ...r, w: wa }, { ...r, x: r.x + wa, w: r.w - wa }]
  }
  const ha = r.h * t.ratio
  return [{ ...r, h: ha }, { ...r, y: r.y + ha, h: r.h - ha }]
}

export function leaves(t: PaneNode): string[] {
  return t.kind === 'leaf' ? [t.id] : [...leaves(t.a), ...leaves(t.b)]
}

const EPS = 1e-9

export function neighbor(t: PaneNode, from: string, dir: Dir): string | null {
  const rects = layoutRects(t)
  const me = rects[from]
  if (!me) return null
  const horizontal = dir === 'left' || dir === 'right'
  let best: { id: string; overlap: number; start: number } | null = null
  for (const id of leaves(t)) {
    if (id === from) continue
    const o = rects[id]
    const adjacent =
      dir === 'right' ? Math.abs(o.x - (me.x + me.w)) < EPS
      : dir === 'left' ? Math.abs(o.x + o.w - me.x) < EPS
      : dir === 'down' ? Math.abs(o.y - (me.y + me.h)) < EPS
      : Math.abs(o.y + o.h - me.y) < EPS
    if (!adjacent) continue
    const overlap = horizontal
      ? Math.min(me.y + me.h, o.y + o.h) - Math.max(me.y, o.y)
      : Math.min(me.x + me.w, o.x + o.w) - Math.max(me.x, o.x)
    if (overlap <= EPS) continue
    const start = horizontal ? o.y : o.x
    // Наибольшее перекрытие; при равенстве — верхний/левый (порядок leaves это и даёт, start — страховка).
    if (!best || overlap > best.overlap + EPS || (Math.abs(overlap - best.overlap) <= EPS && start < best.start)) {
      best = { id, overlap, start }
    }
  }
  return best?.id ?? null
}

/** Меняет ratio у разделителя по пути из 'a'/'b' от корня. */
export function setRatioAt(t: PaneNode, path: ('a' | 'b')[], ratio: number): PaneNode {
  if (t.kind === 'leaf') return t
  if (path.length === 0) return { ...t, ratio }
  const [head, ...rest] = path
  return head === 'a' ? { ...t, a: setRatioAt(t.a, rest, ratio) } : { ...t, b: setRatioAt(t.b, rest, ratio) }
}
