// Всплывающий мини-просмотр над значком и полноразмерная картинка (↵ целиком) поверх панели.
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { loadFullImage, type ImageData } from './api'
import { PreviewCard } from './PreviewCard'
import type { PreviewApi, PreviewState } from './usePreview'

/** Зазор между значком и карточкой. */
const GAP = 6
/** Карточка не ближе к краю панели. */
const EDGE = 8
/** Карточка левее значка (как в макете: значок под заголовком карточки). */
const SHIFT = 12

export interface PreviewLayerProps {
  state: PreviewState
  api: PreviewApi
  /** Панель: координаты карточки — относительно неё. */
  container: RefObject<HTMLElement | null>
  cwd?(): string | null | undefined
  home?: string
}

function anchorOf(state: PreviewState): HTMLElement | null {
  const t = state.target
  if (!t) return null
  if (t.el.isConnected) return t.el
  return t.root?.querySelector<HTMLElement>(`[data-tk="${t.token.id.replace(/["\\]/g, '\\$&')}"]`) ?? null
}

export function PreviewLayer({ state, api, container, cwd, home }: PreviewLayerProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const target = state.target

  // Положение: над значком (не влезает — под ним), в пределах панели. Значок двигается (набор,
  // прокрутка ленты) — карточка за ним; пропал — просмотр закрывается.
  useLayoutEffect(() => {
    if (!target) return
    let raf = 0
    const place = () => {
      const box = container.current?.getBoundingClientRect()
      const card = ref.current
      const a = anchorOf(state)
      if (!a) return api.close()
      if (!box || !card) return
      const r = a.getBoundingClientRect()
      const w = card.offsetWidth
      const h = card.offsetHeight
      let top = r.top - box.top - GAP - h
      if (top < EDGE) top = r.bottom - box.top + GAP
      const left = Math.max(EDGE, Math.min(r.left - box.left - SHIFT, box.width - w - EDGE))
      setPos((p) => (p && p.left === left && p.top === top ? p : { left, top }))
    }
    place()
    const tick = () => {
      place()
      raf = requestAnimationFrame(tick)
    }
    if (typeof requestAnimationFrame === 'function') raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, state, api, container])

  return (
    <>
      {target && (
        <div
          ref={ref}
          className="pv-float"
          style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' }}
          onMouseEnter={api.enterCard}
          onMouseLeave={api.leaveCard}
          // Клик по карточке не уводит фокус из строки ввода.
          onMouseDown={(e) => e.preventDefault()}
          role="dialog"
          aria-label={`Просмотр: ${target.token.label}`}
        >
          <PreviewCard
            token={target.token}
            data={state.data}
            variant={target.from === 'bubble' && target.token.kind === 'image' ? 'bubble' : 'card'}
            fromInput={target.from === 'input'}
            cwd={cwd?.()}
            home={home}
          />
        </div>
      )}
      {state.overlay && <FullImage path={state.overlay.path} label={state.overlay.label} onClose={api.closeOverlay} />}
    </>
  )
}

/** Картинка целиком (уменьшенная копия из Rust) поверх панели; esc, ↵, ␣ или клик — закрыть. */
function FullImage({ path, label, onClose }: { path: string; label: string; onClose(): void }) {
  const [img, setImg] = useState<ImageData | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    loadFullImage(path)
      .then((d) => live && setImg(d))
      .catch((e: unknown) => live && setErr(String(e)))
    return () => {
      live = false
    }
  }, [path])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  return (
    <div className="pv-full" role="dialog" aria-label={label} onMouseDown={(e) => e.preventDefault()} onClick={onClose}>
      {img && <img src={img.src} alt={label} draggable={false} />}
      {err && <div className="pv-err">{err}</div>}
      <div className="pv-full-cap">
        {label}
        {img ? ` · ${img.width}×${img.height}` : ''} · esc закрыть
      </div>
    </div>
  )
}
