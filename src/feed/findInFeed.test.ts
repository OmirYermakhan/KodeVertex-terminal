import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearPaneHighlights, FIND_CURRENT, FIND_HIGHLIGHT, findCount, findRanges, foldCase, setPaneHighlights } from './findInFeed'

function feed(html: string): HTMLDivElement {
  const el = document.createElement('div')
  el.innerHTML = html
  document.body.appendChild(el)
  return el
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('findRanges', () => {
  it('без учёта регистра по умолчанию, в блоках и карточках; кнопки и xterm не ищутся', () => {
    const f = feed(
      '<div class="blk"><div class="hover-act"><button>Error</button></div><div class="bh">❯ make</div>' +
        "<div class='out'><div><span>error: x</span></div><div><span>ERROR</span></div></div></div>" +
        '<div class="card"><p>Ошибка <b>Err</b>or в коде</p></div>' +
        '<div class="feed-park"><div class="live-host">error</div></div>',
    )
    const rs = findRanges(f, 'error')
    expect(rs.map((r) => r.toString())).toEqual(['error', 'ERROR', 'Error'])
    // Совпадение через <b>: диапазон из двух текстовых узлов.
    expect(rs[2].startContainer).not.toBe(rs[2].endContainer)
    expect(findRanges(f, 'error', true).map((r) => r.toString())).toEqual(['error'])
  })

  it('не склеивает соседние строки вывода и элементы ленты', () => {
    const f = feed("<div><div><span>ab</span></div><div><span>cd</span></div></div><div>ef</div>")
    expect(findRanges(f, 'bc')).toHaveLength(0)
    expect(findRanges(f, 'de')).toHaveLength(0)
    expect(findRanges(f, 'cd')).toHaveLength(1)
  })

  it('несколько совпадений в узле; пустой запрос — ничего', () => {
    const f = feed('<p>aXaXa</p>')
    expect(findRanges(f, 'a').map((r) => [r.startOffset, r.endOffset])).toEqual([[0, 1], [2, 3], [4, 5]])
    expect(findRanges(f, '')).toEqual([])
  })

  it('кириллица без учёта регистра', () => {
    const f = feed('<p>Привет, ПРИВЕТ</p>')
    expect(findRanges(f, 'привет')).toHaveLength(2)
  })
})

describe('foldCase / findCount', () => {
  it('длина строки не меняется', () => {
    expect(foldCase('İx')).toHaveLength(2)
    expect(foldCase('AbЯ')).toBe('abя')
  })
  it('«N из M»', () => {
    expect(findCount(0, 3, 'a')).toBe('1 из 3')
    expect(findCount(-1, 0, 'a')).toBe('0 из 0')
    expect(findCount(-1, 0, '')).toBe('')
  })
})

describe('подсветка', () => {
  it('без CSS Custom Highlight API — без ошибок', () => {
    const f = feed('<p>abc</p>')
    const rs = findRanges(f, 'b')
    expect(() => setPaneHighlights('p', rs, rs[0])).not.toThrow()
    expect(() => clearPaneHighlights('p')).not.toThrow()
  })

  it('с API: текущее — отдельной подсветкой, панели объединяются, закрытие убирает', () => {
    const reg = new Map<string, { ranges: Range[] }>()
    class FakeHighlight {
      ranges: Range[]
      constructor(...r: Range[]) {
        this.ranges = r
      }
      add(r: Range) {
        this.ranges.push(r)
      }
    }
    vi.stubGlobal('CSS', { highlights: reg })
    vi.stubGlobal('Highlight', FakeHighlight)
    const f = feed('<p>a a a</p>')
    const rs = findRanges(f, 'a')
    setPaneHighlights('p1', rs, rs[1])
    expect(reg.get(FIND_HIGHLIGHT)!.ranges).toEqual([rs[0], rs[2]])
    expect(reg.get(FIND_CURRENT)!.ranges).toEqual([rs[1]])
    const other = findRanges(feed('<p>a</p>'), 'a')
    setPaneHighlights('p2', other, null)
    expect(reg.get(FIND_HIGHLIGHT)!.ranges).toHaveLength(3)
    clearPaneHighlights('p1')
    clearPaneHighlights('p2')
    expect(reg.size).toBe(0)
  })
})
