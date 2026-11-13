// Плавные анимации интерфейса: только opacity / transform / height.
// Появление карточек, блоков, строк очереди и выборок — CSS-ключевые кадры (global.css, внутри
// @media (prefers-reduced-motion: no-preference)); раскрытие и сворачивание по высоте — здесь (JS),
// потому что высоту «auto» CSS не анимирует. Стрим ответа не анимируется: карточка монтируется
// один раз, дельты текста её не перемонтируют.
import { Component, useEffect, useRef, useState, type ReactNode } from 'react'

/** Раскрытие подробностей агента, сворачивание вопроса после ответа. */
export const EXPAND_MS = 160
/** Уход строки очереди. */
export const LEAVE_MS = 120

/** Системная настройка «Уменьшить движение»: анимации выключены. */
export function prefersReducedMotion(): boolean {
  try {
    return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

/** Есть ли вообще анимации из JS (Web Animations и не «Уменьшить движение»). */
export function motionAvailable(): boolean {
  return typeof HTMLElement !== 'undefined' && typeof HTMLElement.prototype.animate === 'function' && !prefersReducedMotion()
}

/** Можно ли анимировать элемент из JS (нет Web Animations — например, в тестах — или движение уменьшено). */
export function canAnimate(el: Element | null | undefined): el is HTMLElement {
  return !!el && typeof (el as HTMLElement).animate === 'function' && !prefersReducedMotion()
}

/** Высота from → to (px) с прозрачностью; null — без анимации. */
export function animateHeight(el: HTMLElement, from: number, to: number, ms = EXPAND_MS): Animation | null {
  if (!canAnimate(el) || from === to) return null
  const op = to > from ? [0, 1] : [1, 0]
  return el.animate(
    [
      { height: `${from}px`, opacity: op[0] },
      { height: `${to}px`, opacity: op[1] },
    ],
    { duration: ms, easing: 'ease-out' },
  )
}

interface CollapseProps {
  open: boolean
  children?: ReactNode
  className?: string
  ms?: number
}

interface CollapseState {
  /** Закрылся, а сворачивание ещё идёт — коробка (с копией содержимого) на месте. */
  leaving: boolean
  wasOpen: boolean
}

type Snapshot = { node: HTMLElement; height: number } | null

/**
 * Раскрытие / сворачивание по высоте (0 ↔ высота содержимого). Закрытый — ничего не рисует.
 * При закрытии React сразу убирает содержимое (его ref'ы и обработчики не живут дольше, чем надо),
 * а на время анимации остаётся неинтерактивная DOM-копия прежнего вида — getSnapshotBeforeUpdate
 * снимает её до того, как React изменит DOM.
 */
export class Collapse extends Component<CollapseProps, CollapseState> {
  state: CollapseState = { leaving: false, wasOpen: this.props.open }
  private box: HTMLDivElement | null = null
  private ghost: HTMLElement | null = null
  private anim: Animation | null = null

  static getDerivedStateFromProps(p: CollapseProps, s: CollapseState): Partial<CollapseState> | null {
    if (p.open === s.wasOpen) return null
    return { wasOpen: p.open, leaving: !p.open && motionAvailable() }
  }

  private stop() {
    this.anim?.cancel()
    this.anim = null
    this.ghost?.remove()
    this.ghost = null
  }

  componentDidMount() {
    if (this.props.open) this.expand()
  }

  getSnapshotBeforeUpdate(prev: CollapseProps): Snapshot {
    const box = this.box
    if (!prev.open || this.props.open || !this.state.leaving || !canAnimate(box) || box.childNodes.length === 0) return null
    const clone = document.createElement('div')
    for (const n of Array.from(box.childNodes)) if (n !== this.ghost) clone.appendChild(n.cloneNode(true))
    return { node: clone, height: box.getBoundingClientRect().height }
  }

  componentDidUpdate(prev: CollapseProps, _s: CollapseState, snap: Snapshot) {
    if (!prev.open && this.props.open) {
      this.stop()
      this.expand()
      return
    }
    if (!prev.open || this.props.open) return
    this.stop()
    const box = this.box
    const a = snap && box ? animateHeight(box, snap.height, 0, this.props.ms) : null
    if (!snap || !box || !a) {
      if (this.state.leaving) this.setState({ leaving: false })
      return
    }
    const g = snap.node
    g.setAttribute('inert', '')
    g.setAttribute('aria-hidden', 'true')
    box.appendChild(g)
    this.ghost = g
    this.anim = a
    a.onfinish = () => {
      if (this.anim !== a) return
      this.stop()
      this.setState({ leaving: false })
    }
  }

  componentWillUnmount() {
    this.stop()
  }

  private expand() {
    const box = this.box
    if (!box) return
    const a = animateHeight(box, 0, box.getBoundingClientRect().height, this.props.ms)
    this.anim = a
    if (a) {
      a.onfinish = () => {
        if (this.anim === a) this.anim = null
      }
    }
  }

  render() {
    if (!this.props.open && !this.state.leaving) return null
    return (
      <div
        className={this.props.className ? `kv-collapse ${this.props.className}` : 'kv-collapse'}
        ref={(el) => {
          this.box = el
        }}
      >
        {this.props.open ? this.props.children : null}
      </div>
    )
  }
}

export interface Presence<T> {
  item: T
  /** Уходит: виден ещё LEAVE_MS, затем пропадает. */
  leaving: boolean
}

/**
 * Список с уходящими элементами: убранный элемент остаётся на прежнем месте с leaving = true
 * на ms, чтобы CSS доиграл анимацию ухода. При уменьшенном движении (и без Web Animations — в тестах) — сразу.
 */
export function usePresence<T>(list: readonly T[], keyOf: (x: T) => string | number, ms = LEAVE_MS): Presence<T>[] {
  const prevRef = useRef<Presence<T>[]>([])
  const [, force] = useState(0)

  const keys = new Set(list.map(keyOf))
  const out: Presence<T>[] = list.map((item) => ({ item, leaving: false }))
  if (motionAvailable()) {
    // Ушедшие вставляем на их прежние места (после ближайшего оставшегося предыдущего соседа).
    const prev = prevRef.current
    prev.forEach((p, i) => {
      if (keys.has(keyOf(p.item))) return
      let at = 0
      for (let j = i - 1; j >= 0; j--) {
        const k = keyOf(prev[j].item)
        const idx = out.findIndex((o) => keyOf(o.item) === k)
        if (idx >= 0) {
          at = idx + 1
          break
        }
      }
      out.splice(at, 0, { item: p.item, leaving: true })
    })
  }
  prevRef.current = out

  const leavingKeys = out
    .filter((o) => o.leaving)
    .map((o) => keyOf(o.item))
    .join('\u0000')
  useEffect(() => {
    if (!leavingKeys) return
    const t = setTimeout(() => {
      prevRef.current = prevRef.current.filter((o) => !o.leaving)
      force((n) => n + 1)
    }, ms)
    return () => clearTimeout(t)
  }, [leavingKeys, ms])
  return out
}
