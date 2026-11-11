import { useEffect, useRef, type PointerEvent } from 'react'
import { childRects, layoutRects, type PaneNode, type Rect } from '../layout/paneTree'
import { useTabs, type Tab } from '../layout/tabsStore'
import { TerminalPane } from '../terminal/TerminalPane'

interface Divider {
  path: ('a' | 'b')[]
  axis: 'row' | 'col'
  rect: Rect // прямоугольник всего разделения
  ratio: number
}

function dividers(t: PaneNode, rect: Rect = { x: 0, y: 0, w: 1, h: 1 }, path: ('a' | 'b')[] = []): Divider[] {
  if (t.kind === 'leaf') return []
  const [ra, rb] = childRects(t, rect)
  return [
    { path, axis: t.axis, rect, ratio: t.ratio },
    ...dividers(t.a, ra, [...path, 'a']),
    ...dividers(t.b, rb, [...path, 'b']),
  ]
}

const pct = (v: number) => `${v * 100}%`

/**
 * Панели рисуются плоским списком с абсолютным позиционированием (ключ — id панели),
 * поэтому при сплитах и закрытии соседей React не перемонтирует TerminalPane и PTY живёт.
 */
export default function PaneView({ tab, visible }: { tab: Tab; visible: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const { focus, setCwd, paneExited, setRatio } = useTabs.getState()
  const rects = layoutRects(tab.tree)
  const stopDrag = useRef<(() => void) | null>(null)
  useEffect(() => () => stopDrag.current?.(), [])

  const startDrag = (d: Divider) => (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const host = hostRef.current
    if (!host) return
    const box = host.getBoundingClientRect()
    const move = (ev: globalThis.PointerEvent) => {
      const ratio =
        d.axis === 'row'
          ? ((ev.clientX - box.left) / box.width - d.rect.x) / d.rect.w
          : ((ev.clientY - box.top) / box.height - d.rect.y) / d.rect.h
      setRatio(tab.id, d.path, ratio)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      stopDrag.current = null
    }
    stopDrag.current = up
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  return (
    <div
      ref={hostRef}
      data-testid={`tab-${tab.id}`}
      style={{ position: 'absolute', inset: 0, display: visible ? 'block' : 'none' }}
    >
      {Object.entries(rects).map(([id, r]) => (
        <div
          key={id}
          data-testid={`pane-${id}`}
          style={{
            position: 'absolute',
            left: pct(r.x),
            top: pct(r.y),
            width: pct(r.w),
            height: pct(r.h),
            boxSizing: 'border-box',
            borderTop: `2px solid ${tab.focused === id ? 'var(--acc)' : 'transparent'}`,
          }}
        >
          <TerminalPane
            paneId={id}
            focused={visible && tab.focused === id}
            initialCwd={tab.cwd[id]}
            onCwd={(cwd) => setCwd(id, cwd)}
            onExit={() => paneExited(id)}
            onFocus={() => focus(id)}
          />
        </div>
      ))}
      {dividers(tab.tree).map((d) => {
        const row = d.axis === 'row'
        const pos = row ? d.rect.x + d.rect.w * d.ratio : d.rect.y + d.rect.h * d.ratio
        return (
          <div
            key={d.path.join('') || 'root'}
            role="separator"
            onPointerDown={startDrag(d)}
            style={{
              position: 'absolute',
              ...(row
                ? { left: `calc(${pct(pos)} - 3px)`, top: pct(d.rect.y), width: 7, height: pct(d.rect.h), cursor: 'col-resize' }
                : { top: `calc(${pct(pos)} - 3px)`, left: pct(d.rect.x), height: 7, width: pct(d.rect.w), cursor: 'row-resize' }),
              zIndex: 1,
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
            }}
          >
            <div style={{ background: 'var(--rule)', ...(row ? { width: 1, height: '100%' } : { height: 1, width: '100%' }) }} />
          </div>
        )
      })}
    </div>
  )
}
