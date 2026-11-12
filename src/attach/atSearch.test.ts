import { describe, expect, it } from 'vitest'
import { atRows, AT_FEED_MAX, SEARCH_MAX, searchIndexSize, type AtFeed } from './atSearch'
import { blockTextOf } from '../feed/blockHtml'
import type { ShellBlock } from '../feed/feed'

const blk = (id: string, command: string, out: string, exitCode: number | null = 0, running = false): ShellBlock => ({
  kind: 'shell',
  id,
  command,
  cwd: '/w',
  startedAt: 0,
  durationMs: 10,
  exitCode,
  html: `<pre><div><span>${out}</span></div></pre>`,
  lines: 1,
  running,
})
const files = (...names: string[]) => names.map((name) => ({ name, isDir: name.endsWith('/'), isSymlink: false }))

const feed: AtFeed = {
  blocks: [blk('b1', 'git status', 'On branch main'), blk('b2', 'npm test', 'FAIL form.test.tsx', 1), blk('b3', 'ls', 'x', 0, true)],
  messages: [
    { id: 'm1', text: 'Старое сообщение про **Form** компонент', agent: { id: 'main', name: 'Главный' } as never },
    { id: 'm2', text: 'Form готова, проверьте её у себя', agent: { id: 'main', name: 'Главный' } as never },
  ],
}

describe('выбор `@`: группы', () => {
  it('порядок групп: файлы, блоки, сообщения; новые выше; идущий блок не предлагается', () => {
    const r = atRows('', '', files('form.css', 'Form.tsx'), feed)
    expect(r.map((x) => x.key)).toEqual(['f:form.css', 'f:Form.tsx', 'b:b2', 'b:b1', 'm:m2', 'm:m1'])
  })

  it('блок совпадает по команде или по выводу: из вывода — слово с совпадением', () => {
    const r = atRows('fo', '', [], feed)
    const b = r.filter((x) => x.group === 'blocks')
    expect(b).toHaveLength(1)
    expect(b[0]).toMatchObject({ key: 'b:b2', detail: 'form.test.tsx', detailMark: [0, 2], cmdMark: null })
    const c = atRows('stat', '', [], feed).find((x) => x.group === 'blocks')
    expect(c).toMatchObject({ key: 'b:b1', detail: null, cmdMark: [4, 8] })
  })

  it('сообщение совпадает по тексту (без разметки, без регистра): отрывок с начала слова', () => {
    const m = atRows('fo', '', [], feed).filter((x) => x.group === 'messages')
    expect(m.map((x) => x.key)).toEqual(['m:m2', 'm:m1'])
    expect(m[0]).toMatchObject({ snippet: 'Form готова, про…', mark: [0, 2] })
    expect(m[1]).toMatchObject({ snippet: 'Form компонент', mark: [0, 2] })
    expect(atRows('нет такого', '', [], feed)).toEqual([])
  })

  it('в папке (после `/`) — только файлы; без ленты — только файлы', () => {
    expect(atRows('', 'src/', files('a.ts'), feed).map((x) => x.group)).toEqual(['files'])
    expect(atRows('', '', files('a.ts'), null).map((x) => x.group)).toEqual(['files'])
  })

  it('не больше трёх блоков и сообщений; файлы — до 8 строк вместе с ними, но не меньше трёх', () => {
    const many: AtFeed = { blocks: Array.from({ length: 6 }, (_, i) => blk(`b${i}`, `cmd${i}`, '')), messages: [] }
    const r = atRows('', '', files(...Array.from({ length: 20 }, (_, i) => `f${i}`)), many)
    expect(r.filter((x) => x.group === 'blocks')).toHaveLength(AT_FEED_MAX)
    expect(r.filter((x) => x.group === 'files')).toHaveLength(5)
    // Только файлы — все (прокрутка).
    expect(atRows('', '', files(...Array.from({ length: 20 }, (_, i) => `f${i}`)), null)).toHaveLength(20)
  })
})

describe('выбор `@`: индекс поиска', () => {
  it('текст блока разбирается один раз и ищется по хвосту не длиннее 64 КБ; индекс сообщений не растёт от набора', () => {
    const head = 'needle ' + 'x'.repeat(SEARCH_MAX + 100) + ' tailword'
    const b = blk('big', 'cat log', head)
    const f: AtFeed = { blocks: [b], messages: feed.messages }
    expect(blockTextOf(b)).toBe(blockTextOf(b))
    expect(atRows('tailword', '', [], f).some((r) => r.group === 'blocks')).toBe(true)
    // Совпадение только в начале огромного вывода — за пределами хвоста.
    expect(atRows('needle', '', [], f).some((r) => r.group === 'blocks')).toBe(false)
    atRows('fo', '', [], f)
    const n = searchIndexSize()
    for (const q of ['f', 'fo', 'for', 'form']) atRows(q, '', [], f)
    expect(searchIndexSize()).toBe(n)
  })
})
