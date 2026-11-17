import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useTabs, type Tab } from '../layout/tabsStore'
import { projectName, useHome, type GitInfo } from '../status/useGitInfo'
import { claudeOpen, useClaudeSessions } from '../claude/sessionStore'
import { tabStatus, type ClaudeStatus } from './tabStatus'
import ProjectButton from '../project/ProjectButton'
import { useSettings } from '../settings/store'
import { LauncherIcon } from '../launch/LauncherIcon'
import { canMoveToNewWindow, moveTabToNewWindow, moveTabToWindow, windowAt } from '../windows/transfer'
import { logError } from '../diag/log'

/** Сдвиг курсора (px), после которого нажатие на вкладке становится перетаскиванием. */
const DRAG_THRESHOLD = 4
/** Отпустили ниже полосы больше чем на столько (px) — вкладка уезжает в новое окно. */
const DETACH_BELOW = 40

/** Нажатие на вкладке (до и во время перетаскивания); снимок мест вкладок — на начало перетаскивания. */
interface Press {
  id: string
  from: number
  pointerId: number
  el: HTMLElement
  x0: number
  y0: number
  dragging: boolean
  rects: { left: number; width: number }[]
  /** Расстояние между соседними вкладками (gap полосы). */
  gap: number
  /** Где взяли вкладку относительно её левого верхнего угла — «призрак» держится так же. */
  offX: number
  offY: number
}

/** Что рисует перетаскивание: место вставки, сдвиг вкладки, курсор (для «призрака»). */
interface DragView {
  id: string
  from: number
  to: number
  dx: number
  inBar: boolean
  x: number
  y: number
  /** На сколько расступаются соседи: ширина вкладки + gap. */
  shift: number
  offX: number
  offY: number
}

/** Вкладку отпустили не над полосой: в другое окно под курсором, в новое — или отмена. */
async function dropOutside(id: string, e: { screenX: number; screenY: number; clientX: number; clientY: number }, barBottom: number) {
  const label = await windowAt(e.screenX, e.screenY)
  if (label) {
    await moveTabToWindow(id, label)
    return
  }
  const outside = e.clientX < 0 || e.clientY < 0 || e.clientX > window.innerWidth || e.clientY > window.innerHeight
  if (!outside && e.clientY <= barBottom + DETACH_BELOW) return
  if (await canMoveToNewWindow()) await moveTabToNewWindow(id, e.screenX, e.screenY)
}

export function tabTitle(t: Tab, git: GitInfo | null = null, home = ''): string {
  const cwd = t.cwd[t.focused]
  return cwd ? projectName(cwd, git, home) : 'Терминал'
}

/**
 * Полоса вкладок (макет 04-main-window `.bar/.tabs/.tab`). Кнопки окна macOS — родные
 * (titleBarStyle: Overlay, trafficLightPosition на месте трёх точек макета). Сразу за ними —
 * кнопка проекта (макет 07 `.proj`): 20px от правого края «развернуть», как от третьей точки в макете;
 * вкладки — в 18px за ней (gap 8 + margin 10 макета).
 * Перетаскивание окна работает только по самой полосе и пустому месту: у вкладок и кнопки атрибута нет.
 * activeGit — git-данные активной вкладки (считаются один раз в App); у остальных вкладок — имя папки.
 *
 * Точка вкладки: работает — синяя пульсирующая, ждёт — жёлтая, ошибка — красная, готово — зелёная,
 * пока вкладку не открыли; у активной вкладки без этих состояний — точка --acc, как в макете.
 *
 * Перетаскивание вкладки (pointer events с захватом указателя: macOS шлёт движение окну, где нажали,
 * даже за его пределами; порог — DRAG_THRESHOLD). Над полосой — перестановка вживую (вкладка идёт за
 * курсором, соседи расступаются, порядок в сторе меняется при отпускании). Вне полосы — вкладка на
 * своём месте полупрозрачна, за курсором «призрак» с названием; отпустили над другим окном — перенос
 * туда, за пределами окна или ниже полосы на DETACH_BELOW+ — в новое окно, иначе — отмена.
 * Escape, pointercancel и потеря захвата — отмена. Клик без движения — активировать, как раньше.
 */
export default function TabBar({ activeGit = null }: { activeGit?: GitInfo | null }) {
  const tabs = useTabs((s) => s.tabs)
  const active = useTabs((s) => s.active)
  // Из сессий — только то, что рисует полоса (по вкладке: точка, время «готово», «· claude»), плоским
  // массивом со сравнением по элементам: токены ответа в любой панели полосу не перерисовывают.
  const flat = useClaudeSessions(
    useShallow((s) =>
      tabs.flatMap((t) => {
        const st = tabStatus(t, s.sessions)
        return [st?.status ?? null, st?.doneAt ?? 0, claudeOpen(s.sessions[t.focused])]
      }),
    ),
  )
  const info = (i: number) => {
    const status = flat[i * 3] as ClaudeStatus | null
    return { st: status ? { status, doneAt: flat[i * 3 + 1] as number } : null, claude: flat[i * 3 + 2] as boolean }
  }
  const { activate, closeTab, newTab, move } = useTabs.getState()
  const home = useHome()
  const launchers = useSettings((s) => s.settings.launchers)
  // Когда вкладку смотрели в последний раз: «готово» после этого — ещё не увиденное.
  const [seen, setSeen] = useState<Record<string, number>>({})

  const barRef = useRef<HTMLDivElement>(null)
  const press = useRef<Press | null>(null)
  // Клик, который браузер шлёт после перетаскивания, вкладку не активирует.
  const skipClick = useRef(false)
  const [drag, setDrag] = useState<DragView | null>(null)

  const cancelDrag = useCallback(() => {
    const p = press.current
    if (!p) return
    press.current = null
    if (p.dragging) skipClick.current = true
    try {
      if (p.el.hasPointerCapture?.(p.pointerId)) p.el.releasePointerCapture(p.pointerId)
    } catch {
      // захвата уже нет
    }
    setDrag(null)
  }, [])

  const dragging = drag !== null
  useEffect(() => {
    if (!dragging) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      cancelDrag()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [dragging, cancelDrag])

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>, id: string, i: number) => {
    skipClick.current = false
    if (e.button !== 0 || press.current) return
    if ((e.target as Element).closest('.tab-close')) return
    const el = e.currentTarget
    try {
      el.setPointerCapture?.(e.pointerId)
    } catch {
      // без захвата перетаскивание работает, пока курсор над окном
    }
    press.current = { id, from: i, pointerId: e.pointerId, el, x0: e.clientX, y0: e.clientY, dragging: false, rects: [], gap: 0, offX: 0, offY: 0 }
  }

  /** Состояние перетаскивания для курсора (clientX, clientY). */
  const view = (p: Press, x: number, y: number): DragView => {
    const bar = barRef.current?.getBoundingClientRect()
    const inBar = !!bar && x >= bar.left && x <= bar.right && y >= bar.top && y <= bar.bottom
    const r = p.rects[p.from]
    const base = { id: p.id, from: p.from, x, y, inBar, shift: r.width + p.gap, offX: p.offX, offY: p.offY }
    if (!inBar) return { ...base, to: p.from, dx: 0 }
    const last = p.rects[p.rects.length - 1]
    const left = Math.min(Math.max(r.left + x - p.x0, p.rects[0].left), last.left + last.width - r.width)
    const center = left + r.width / 2
    // Соседку обходим, когда центр взятой вкладки дошёл до её середины (у края полосы — ровно до неё).
    let to = p.from
    p.rects.forEach((q, j) => {
      const mid = q.left + q.width / 2
      if (j > p.from && center >= mid) to++
      else if (j < p.from && center <= mid) to--
    })
    return { ...base, to, dx: left - r.left }
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = press.current
    if (!p || e.pointerId !== p.pointerId) return
    if (!p.dragging) {
      if (Math.hypot(e.clientX - p.x0, e.clientY - p.y0) < DRAG_THRESHOLD) return
      const els = barRef.current ? [...barRef.current.querySelectorAll<HTMLElement>('[role="tab"]')] : []
      if (els[p.from] !== p.el) {
        // Полоса изменилась под нажатием — не тащим.
        cancelDrag()
        return
      }
      p.rects = els.map((el) => {
        const b = el.getBoundingClientRect()
        return { left: b.left, width: b.width }
      })
      p.gap = p.rects.length > 1 ? Math.max(0, p.rects[1].left - p.rects[0].left - p.rects[0].width) : 0
      const own = p.el.getBoundingClientRect()
      p.offX = p.x0 - own.left
      p.offY = p.y0 - own.top
      p.dragging = true
    }
    setDrag(view(p, e.clientX, e.clientY))
  }

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = press.current
    if (!p || e.pointerId !== p.pointerId) return
    press.current = null
    if (!p.dragging) return // обычный клик — его обработает onClick
    skipClick.current = true
    const v = view(p, e.clientX, e.clientY)
    setDrag(null)
    const from = useTabs.getState().tabs.findIndex((t) => t.id === p.id)
    if (from < 0) return
    if (v.inBar) {
      if (from === p.from && v.to !== from) move(from, v.to)
      return
    }
    const barBottom = barRef.current?.getBoundingClientRect().bottom ?? 0
    const pt = { screenX: e.screenX, screenY: e.screenY, clientX: e.clientX, clientY: e.clientY }
    dropOutside(p.id, pt, barBottom).catch((err: unknown) => logError('tabs', `перенос вкладки: ${String(err)}`))
  }

  const titles = tabs.map((t, i) => {
    const l = t.launcher ? launchers.find((x) => x.id === t.launcher) : undefined
    return (l ? l.name : tabTitle(t, t.id === active ? activeGit : null, home)) + (info(i).claude ? ' · claude' : '')
  })
  const ghostIdx = drag && !drag.inBar ? tabs.findIndex((t) => t.id === drag.id) : -1

  /** Сдвиг вкладки i во время перестановки (сама перетаскиваемая — за курсором). */
  const offset = (i: number, id: string): number => {
    if (!drag) return 0
    if (id === drag.id) return drag.dx
    if (drag.from < drag.to && i > drag.from && i <= drag.to) return -drag.shift
    if (drag.to < drag.from && i >= drag.to && i < drag.from) return drag.shift
    return 0
  }

  const activeIdx = tabs.findIndex((t) => t.id === active)
  const activeTab = activeIdx >= 0 ? tabs[activeIdx] : undefined
  const activeDoneAt = activeTab ? (info(activeIdx).st?.doneAt ?? 0) : 0
  useEffect(() => {
    if (!active) return
    setSeen((s) => ({ ...s, [active]: Date.now() }))
  }, [active, activeDoneAt])

  return (
    <div ref={barRef} data-testid="tabbar" data-tauri-drag-region className={drag ? 'bar tab-drag' : 'bar'}>
      <ProjectButton cwd={activeTab?.cwd[activeTab.focused]} git={activeGit} />
      {tabs.map((t, i) => {
        const on = t.id === active
        const { st } = info(i)
        let dot: string | null = on ? 'on' : null
        if (st && st.status !== 'done') dot = st.status
        else if (st?.status === 'done' && !on && st.doneAt > (seen[t.id] ?? 0)) dot = 'done'
        const l = t.launcher ? launchers.find((x) => x.id === t.launcher) : undefined
        const title = titles[i]
        const held = drag?.id === t.id
        const dx = offset(i, t.id)
        return (
          <div
            key={t.id}
            role="tab"
            aria-selected={on}
            data-dragging={held || undefined}
            className={(on ? 'tab on' : 'tab') + (held ? ' dragging' : '')}
            style={dx ? { transform: `translateX(${dx}px)` } : undefined}
            onPointerDown={(e) => onPointerDown(e, t.id, i)}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={cancelDrag}
            onLostPointerCapture={(e) => {
              if (press.current?.pointerId === e.pointerId) cancelDrag()
            }}
            onClick={() => {
              if (skipClick.current) {
                skipClick.current = false
                return
              }
              activate(t.id)
            }}
            onAuxClick={(e) => {
              if (e.button === 1) closeTab(t.id)
            }}
          >
            {dot && <i className={`tdot ${dot}`} data-testid="tab-dot" data-status={dot} />}
            {l && (
              <span className="tab-li" style={{ color: l.color }}>
                <LauncherIcon icon={l.icon} size={13} />
              </span>
            )}
            <span>{title}</span>
            <button
              type="button"
              className="tab-close"
              aria-label="Закрыть вкладку"
              onClick={(e) => {
                e.stopPropagation()
                closeTab(t.id)
              }}
            >
              ×
            </button>
          </div>
        )
      })}
      <button type="button" className="tab tab-add" aria-label="Новая вкладка" onClick={() => newTab()}>
        +
      </button>
      <div data-tauri-drag-region style={{ flex: 1, alignSelf: 'stretch' }} />
      {drag && ghostIdx >= 0 && (
        <div className="tab on tab-ghost" data-testid="tab-ghost" aria-hidden style={{ left: drag.x - drag.offX, top: drag.y - drag.offY }}>
          <span>{titles[ghostIdx]}</span>
        </div>
      )}
    </div>
  )
}
