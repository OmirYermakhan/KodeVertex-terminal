import { render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Feed, finishAppear, markStuck } from './FeedView'
import type { FeedItem, ShellBlock } from './feed'

/** Лента из блоков с заданными top/bottom (px относительно окна); верх ленты — 100. */
function feedOf(blocks: [number, number][]) {
  const feed = document.createElement('div')
  feed.getBoundingClientRect = () => ({ top: 100 }) as DOMRect
  for (const [top, bottom] of blocks) {
    const blk = document.createElement('div')
    blk.className = 'blk'
    blk.getBoundingClientRect = () => ({ top, bottom }) as DOMRect
    const bh = document.createElement('div')
    bh.className = 'bh'
    Object.defineProperty(bh, 'offsetHeight', { value: 20 })
    blk.appendChild(bh)
    feed.appendChild(blk)
  }
  return feed
}
const stuck = (feed: HTMLElement) => Array.from(feed.querySelectorAll('.bh')).map((b) => b.classList.contains('stuck'))

describe('прилипший заголовок блока', () => {
  it('прилипает заголовок блока, чей вывод проходит через верх ленты', () => {
    const feed = feedOf([
      [-400, -100], // целиком выше
      [-50, 600], // через верхний край
      [610, 900],
    ])
    markStuck(feed)
    expect(stuck(feed)).toEqual([false, true, false])
  })

  it('блок начинается в ленте — заголовок на своём месте, не прилип', () => {
    const feed = feedOf([
      [-300, 90],
      [100, 500],
    ])
    markStuck(feed)
    expect(stuck(feed)).toEqual([false, false])
  })

  it('хвост блока короче заголовка — линии нет; прокрутка снимает прежний .stuck', () => {
    const feed = feedOf([[-500, 110]])
    feed.querySelector('.bh')!.classList.add('stuck')
    markStuck(feed)
    expect(stuck(feed)).toEqual([false])
  })

  it('карточки Claude между блоками не мешают', () => {
    const feed = feedOf([[-50, 600]])
    const card = document.createElement('div')
    card.className = 'card'
    feed.prepend(card)
    markStuck(feed)
    expect(stuck(feed)).toEqual([true])
  })

  it('⌘↑/⌘↓: выбранный блок прокручен к верху (scrollIntoView nearest) — его заголовок и соседи не прилипли', () => {
    // Верх выбранного блока — ровно у верха ленты; предыдущий блок с отступом 10px — целиком выше.
    const feed = feedOf([
      [-300, -10],
      [100, 900],
    ])
    markStuck(feed)
    expect(stuck(feed)).toEqual([false, false])
  })
})

const block = (id: string): ShellBlock =>
  ({ kind: 'shell', id, command: 'ls', cwd: '/tmp', startedAt: 0, durationMs: 1, exitCode: 0, running: false, html: 'a', lines: 1 }) as ShellBlock
const answer = (text: string): FeedItem => ({ kind: 'claude', id: 'c1', item: { type: 'assistant', agentId: 'main', text, streaming: true } })

describe('пересчёт прилипшего заголовка', () => {
  afterEach(() => vi.restoreAllMocks())

  it('кусок стрима ответа Claude не пересчитывает; новый блок — пересчитывает (не чаще кадра)', () => {
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0)
    const { rerender } = render(<Feed items={[block('b1'), answer('При')]} selectedId={null} renderLive={() => null} />)
    raf.mockClear()
    rerender(<Feed items={[block('b1'), answer('Привет')]} selectedId={null} renderLive={() => null} />)
    rerender(<Feed items={[block('b1'), answer('Привет, мир')]} selectedId={null} renderLive={() => null} />)
    expect(raf).not.toHaveBeenCalled()
    rerender(<Feed items={[block('b1'), answer('Привет, мир'), block('b2')]} selectedId={null} renderLive={() => null} />)
    expect(raf).toHaveBeenCalledTimes(1)
  })
})

describe('пересчёт при росте содержимого', () => {
  const RO = globalThis.ResizeObserver
  afterEach(() => {
    globalThis.ResizeObserver = RO
    vi.restoreAllMocks()
  })

  it('наблюдаются лента и её блоки (не карточки Claude): вырос вывод — пересчёт', () => {
    let cb: () => void = () => {}
    const observed = new Set<Element>()
    globalThis.ResizeObserver = class {
      constructor(c: () => void) {
        cb = c
      }
      observe(el: Element) {
        observed.add(el)
      }
      unobserve(el: Element) {
        observed.delete(el)
      }
      disconnect() {
        observed.clear()
      }
    } as unknown as typeof ResizeObserver
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0)
    const { container, rerender } = render(<Feed items={[block('b1'), answer('При')]} selectedId={null} renderLive={() => null} />)
    const kinds = () => [...observed].map((e) => e.className.split(' ')[0]).sort()
    expect(kinds()).toEqual(['blk', 'feed'])
    rerender(<Feed items={[block('b1'), answer('При'), block('b2')]} selectedId={null} renderLive={() => null} />)
    expect(kinds()).toEqual(['blk', 'blk', 'feed'])
    expect([...observed].filter((e) => e.classList.contains('blk')).every((e) => e.parentElement === container.querySelector('.feed'))).toBe(true)
    raf.mockClear()
    cb()
    expect(raf).toHaveBeenCalledTimes(1)
  })
})

describe('появление при восстановлении сессии', () => {
  it('у элементов, что есть при монтировании, анимация появления сразу доводится до конца', () => {
    const finish = vi.fn()
    const el = document.createElement('div')
    el.appendChild(document.createElement('div'))
    ;(el.firstElementChild as unknown as { getAnimations: () => { finish: () => void }[] }).getAnimations = () => [{ finish }]
    finishAppear(el)
    expect(finish).toHaveBeenCalledTimes(1)
    // Без Web Animations (jsdom) — без ошибок.
    expect(() => finishAppear(feedOf([[0, 10]]))).not.toThrow()
  })
})
