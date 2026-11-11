import { describe, expect, it } from 'vitest'
import { closePane, layoutRects, leaf, leaves, neighbor, setRatioAt, splitPane, type PaneNode } from './paneTree'

// a | (b / c)
function abc(): PaneNode {
  return splitPane(splitPane(leaf('a'), 'a', 'row', 'b'), 'b', 'col', 'c')
}

describe('paneTree', () => {
  it('splits a leaf into a row with ratio 0.5', () => {
    expect(splitPane(leaf('a'), 'a', 'row', 'b')).toEqual({
      kind: 'split',
      axis: 'row',
      ratio: 0.5,
      a: leaf('a'),
      b: leaf('b'),
    })
  })

  it('nests on repeated split', () => {
    const t = abc()
    expect(t.kind === 'split' && t.b.kind === 'split' && t.b.axis).toBe('col')
    expect(leaves(t)).toEqual(['a', 'b', 'c'])
  })

  it('closePane collapses sibling into the parent and returns null for the last leaf', () => {
    const t = splitPane(leaf('a'), 'a', 'row', 'b')
    expect(closePane(t, 'b')).toEqual(leaf('a'))
    expect(closePane(leaf('a'), 'a')).toBeNull()
  })

  it('layoutRects for a|b', () => {
    const r = layoutRects(splitPane(leaf('a'), 'a', 'row', 'b'))
    expect(r.a).toEqual({ x: 0, y: 0, w: 0.5, h: 1 })
    expect(r.b).toEqual({ x: 0.5, y: 0, w: 0.5, h: 1 })
  })

  it('neighbor on a | (b / c)', () => {
    const t = abc()
    expect(neighbor(t, 'a', 'right')).toBe('b') // tie on overlap -> top
    expect(neighbor(t, 'c', 'left')).toBe('a')
    expect(neighbor(t, 'b', 'down')).toBe('c')
    expect(neighbor(t, 'a', 'left')).toBeNull()
  })

  it('setRatioAt updates the split at a path', () => {
    const t = setRatioAt(abc(), ['b'], 0.3)
    expect(t.kind === 'split' && t.b.kind === 'split' && t.b.ratio).toBe(0.3)
  })
})
