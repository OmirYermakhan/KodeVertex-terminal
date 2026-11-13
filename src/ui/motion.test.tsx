import { act, render, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Collapse, animateHeight, canAnimate, prefersReducedMotion, usePresence } from './motion'

function setReduced(reduce: boolean | null) {
  if (reduce === null) {
    // @ts-expect-error — в jsdom matchMedia нет; возвращаем как было.
    delete window.matchMedia
    return
  }
  window.matchMedia = ((q: string) => ({ matches: reduce && q.includes('reduce'), media: q })) as unknown as typeof window.matchMedia
}

/** Web Animations в jsdom нет — подставляем запись вызовов. */
function fakeAnimate() {
  const calls: { el: Element; frames: Keyframe[] }[] = []
  const anims: { onfinish: (() => void) | null; cancel: () => void }[] = []
  ;(HTMLElement.prototype as unknown as { animate: unknown }).animate = function (this: Element, frames: Keyframe[]) {
    calls.push({ el: this, frames })
    const a = { onfinish: null as (() => void) | null, cancel: vi.fn() }
    anims.push(a)
    return a
  }
  return { calls, anims }
}

afterEach(() => {
  setReduced(null)
  delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('prefers-reduced-motion', () => {
  it('без matchMedia — движение не уменьшено', () => {
    expect(prefersReducedMotion()).toBe(false)
  })

  it('системная настройка «Уменьшить движение» выключает анимации из JS', () => {
    fakeAnimate()
    const el = document.createElement('div')
    setReduced(false)
    expect(prefersReducedMotion()).toBe(false)
    expect(canAnimate(el)).toBe(true)
    expect(animateHeight(el, 0, 40)).not.toBeNull()
    setReduced(true)
    expect(prefersReducedMotion()).toBe(true)
    expect(canAnimate(el)).toBe(false)
    expect(animateHeight(el, 0, 40)).toBeNull()
  })

  it('без Web Animations — без анимации', () => {
    expect(canAnimate(document.createElement('div'))).toBe(false)
  })

  it('высота и прозрачность: раскрытие 0 → h, сворачивание h → 0', () => {
    const { calls } = fakeAnimate()
    const el = document.createElement('div')
    animateHeight(el, 0, 50)
    animateHeight(el, 50, 0)
    expect(calls[0].frames).toEqual([
      { height: '0px', opacity: 0 },
      { height: '50px', opacity: 1 },
    ])
    expect(calls[1].frames).toEqual([
      { height: '50px', opacity: 1 },
      { height: '0px', opacity: 0 },
    ])
  })
})

describe('Collapse', () => {
  it('закрытие: содержимое React уходит сразу, на время анимации — неинтерактивная копия', () => {
    const { anims } = fakeAnimate()
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ height: 30 } as DOMRect)
    const { container, rerender } = render(
      <Collapse open>
        <button type="button">Ответить</button>
      </Collapse>,
    )
    const box = container.querySelector('.kv-collapse')!
    rerender(<Collapse open={false}>{null}</Collapse>)
    const ghost = box.firstElementChild!
    expect(ghost.hasAttribute('inert')).toBe(true)
    expect(ghost.textContent).toBe('Ответить')
    expect(box.isConnected).toBe(true)
    act(() => anims[anims.length - 1].onfinish!())
    expect(container.querySelector('.kv-collapse')).toBeNull()
  })

  it('при уменьшенном движении копии нет — закрывается сразу', () => {
    fakeAnimate()
    setReduced(true)
    const { container, rerender } = render(
      <Collapse open>
        <span>x</span>
      </Collapse>,
    )
    expect(container.querySelector('.kv-collapse')).not.toBeNull()
    rerender(<Collapse open={false}>{null}</Collapse>)
    expect(container.querySelector('.kv-collapse')).toBeNull()
  })
})

describe('usePresence', () => {
  const key = (x: { id: number }) => x.id
  const a = { id: 1 }
  const b = { id: 2 }
  const c = { id: 3 }

  it('убранная строка остаётся на месте с leaving, затем пропадает', () => {
    vi.useFakeTimers()
    fakeAnimate()
    const { result, rerender } = renderHook(({ list }) => usePresence(list, key), { initialProps: { list: [a, b, c] } })
    rerender({ list: [a, c] })
    expect(result.current.map((p) => [p.item.id, p.leaving])).toEqual([
      [1, false],
      [2, true],
      [3, false],
    ])
    act(() => {
      vi.advanceTimersByTime(130)
    })
    expect(result.current.map((p) => p.item.id)).toEqual([1, 3])
  })

  it('при уменьшенном движении — пропадает сразу', () => {
    fakeAnimate()
    setReduced(true)
    const { result, rerender } = renderHook(({ list }) => usePresence(list, key), { initialProps: { list: [a, b] } })
    rerender({ list: [b] })
    expect(result.current).toEqual([{ item: b, leaving: false }])
  })
})
