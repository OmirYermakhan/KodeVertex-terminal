import { describe, expect, it } from 'vitest'
import { markStuck } from './FeedView'

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
})
