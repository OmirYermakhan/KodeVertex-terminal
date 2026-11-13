import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { diffParts, diffStat, firstChangedLine, lineDiff, parseHunks, type DiffPart, type FileDiff } from './diff'
import { DIFF_SHOWN, DiffView, shownPath, unchangedLabel } from './cards/DiffView'
import { initialClaude, reduceClaude } from './reducer'

const invoke = vi.fn((..._a: unknown[]) => Promise.resolve())
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))

const show = (parts: DiffPart[]) =>
  parts.map((p) => (p.kind === 'gap' ? `~${p.count}${p.rows ? '' : '!'}` : `${p.row.k}${p.row.o ?? '_'}/${p.row.n ?? '_'} ${p.row.t}`))

const file = (n: number) => Array.from({ length: n }, (_, i) => `l${i + 1}`).join('\n') + '\n'

describe('lineDiff', () => {
  it('общие строки — контекст, изменённые — удалённые перед добавленными', () => {
    expect(lineDiff('a\nb\nc', 'a\nB\nc')).toEqual([
      { k: 'n', t: 'a' },
      { k: 'd', t: 'b' },
      { k: 'a', t: 'B' },
      { k: 'n', t: 'c' },
    ])
    expect(lineDiff('', 'new')).toEqual([{ k: 'a', t: 'new' }])
  })
  it('LCS находит общие строки в середине', () => {
    const r = lineDiff('x\nkeep\ny', 'X\nkeep\nY')
    expect(r.map((x) => x.k + x.t)).toEqual(['dx', 'aX', 'nkeep', 'dy', 'aY'])
  })
})

describe('diffParts', () => {
  it('structuredPatch + исходный файл: номера «было/стало», 3 строки контекста, остальное свёрнуто', () => {
    const original = file(20)
    const d: FileDiff = {
      path: '/p/a.ts',
      before: 'l10',
      after: 'L10\nnew',
      original,
      hunks: [{ oldStart: 7, newStart: 7, lines: [' l7', ' l8', ' l9', '-l10', '+L10', '+new', ' l11', ' l12', ' l13'] }],
    }
    expect(show(diffParts(d))).toEqual([
      '~6',
      'n7/7 l7',
      'n8/8 l8',
      'n9/9 l9',
      'd10/_ l10',
      'a_/10 L10',
      'a_/11 new',
      'n11/12 l11',
      'n12/13 l12',
      'n13/14 l13',
      '~7',
    ])
    // Свёрнутые строки можно развернуть: номера идут со сдвигом после куска.
    const tail = diffParts(d).at(-1)
    expect(tail?.kind === 'gap' && tail.rows?.[0]).toEqual({ k: 'n', o: 14, n: 15, t: 'l14' })
    expect(diffStat(d)).toEqual({ add: 2, del: 1 })
    expect(firstChangedLine(d)).toBe(10)
  })

  it('без исходного файла: между кусками — «N строк без изменений», развернуть нельзя', () => {
    const d: FileDiff = {
      path: '/p/a.ts',
      before: '',
      after: '',
      hunks: [
        { oldStart: 2, newStart: 2, lines: [' a', '-b', '+B'] },
        { oldStart: 30, newStart: 30, lines: ['-c', '+C', ' d'] },
      ],
    }
    expect(show(diffParts(d))).toEqual(['~1!', 'n2/2 a', 'd3/_ b', 'a_/3 B', '~26!', 'd30/_ c', 'a_/30 C', 'n31/31 d'])
  })

  it('созданный файл — всё добавлено с первой строки', () => {
    const d: FileDiff = { path: '/p/n.ts', before: '', after: 'x\ny\n', created: true }
    expect(show(diffParts(d))).toEqual(['a_/1 x', 'a_/2 y'])
    expect(firstChangedLine(d)).toBe(1)
  })

  it('MultiEdit до результата: правки по отдельности, между ними «…»', () => {
    const d: FileDiff = { path: '/p', before: 'a\nb', after: 'A\nB', parts: [{ before: 'a', after: 'A' }, { before: 'b', after: 'B' }] }
    expect(show(diffParts(d))).toEqual(['d_/_ a', 'a_/_ A', '~null!', 'd_/_ b', 'a_/_ B'])
  })

  it('кусок из одной строки не сворачивается', () => {
    const d: FileDiff = { path: '/p', before: '', after: '', original: file(5), hunks: [{ oldStart: 5, newStart: 5, lines: ['-l5', '+L5'] }] }
    // Перед правкой 4 строки: 3 контекста + 1 — показываем все.
    expect(show(diffParts(d))[0]).toBe('n1/1 l1')
  })

  it('parseHunks отбрасывает мусор', () => {
    expect(parseHunks('x')).toBeNull()
    expect(parseHunks([{ oldStart: 1 }])).toBeNull()
    expect(parseHunks([{ oldStart: 1, newStart: 1, oldLines: 1, newLines: 1, lines: ['-a', 2, '+b'] }])).toEqual([{ oldStart: 1, newStart: 1, lines: ['-a', '+b'] }])
  })

  it('подписи свёрнутых строк', () => {
    expect(unchangedLabel(1)).toBe('… 1 строка без изменений')
    expect(unchangedLabel(3)).toBe('… 3 строки без изменений')
    expect(unchangedLabel(12)).toBe('… 12 строк без изменений')
    expect(unchangedLabel(null)).toBe('…')
  })
})

describe('reducer: результат правки', () => {
  const edit = {
    type: 'assistant',
    parent_tool_use_id: null,
    message: { model: 'm', content: [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: '/p/a.ts', old_string: 'l2', new_string: 'L2' } }] },
  }
  const result = (r: object) => ({
    type: 'user',
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e1', content: 'ok' }] },
    tool_use_result: r,
  })

  it('structuredPatch и небольшой originalFile ложатся в diff действия', () => {
    let s = reduceClaude(initialClaude(), edit, 1)
    s = reduceClaude(s, result({ filePath: '/p/a.ts', originalFile: 'l1\nl2\n', structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' l1', '-l2', '+L2'] }] }), 2)
    expect(s.items[0]).toMatchObject({ status: 'done', diff: { path: '/p/a.ts', original: 'l1\nl2\n', hunks: [{ oldStart: 1, newStart: 1 }] } })
  })

  it('событие настоящего CLI (claude 2.1, stream-json --verbose): tool_use_result.structuredPatch', () => {
    // Сокращённые строки прогона `claude -p … --output-format stream-json --verbose` с Edit на временном файле.
    const tu = { type: 'assistant', parent_tool_use_id: null, session_id: 's', message: { model: 'claude-haiku', content: [
      { type: 'tool_use', id: 'toolu_1', name: 'Edit', input: { replace_all: false, file_path: '/tmp/demo/f.txt', old_string: 'line5', new_string: 'LINE5' } } ] } }
    const orig = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n') + '\n'
    const res = {
      type: 'user', parent_tool_use_id: null, session_id: 's', uuid: 'u', timestamp: '2026-11-13T11:30:30.967Z',
      message: { role: 'user', content: [{ tool_use_id: 'toolu_1', type: 'tool_result', content: 'The file /tmp/demo/f.txt has been updated successfully.' }] },
      tool_use_result: { filePath: '/tmp/demo/f.txt', oldString: 'line5', newString: 'LINE5', originalFile: orig,
        structuredPatch: [{ oldStart: 2, oldLines: 7, newStart: 2, newLines: 7, lines: [' line2', ' line3', ' line4', '-line5', '+LINE5', ' line6', ' line7', ' line8'] }],
        userModified: false, replaceAll: false, contentNotInModelContext: true },
      tool_result_meta: [{ id: 'toolu_1', permission_decision: { decision: 'accept', source: 'config', reason_type: 'mode' } }],
    }
    const s = reduceClaude(reduceClaude(initialClaude(), tu, 1), res, 2)
    const it0 = s.items[0]
    expect(it0.type === 'action' && it0.diff && show(diffParts(it0.diff))).toEqual([
      'n1/1 line1', 'n2/2 line2', 'n3/3 line3', 'n4/4 line4', 'd5/_ line5', 'a_/5 LINE5', 'n6/6 line6', 'n7/7 line7', 'n8/8 line8', '~2',
    ])
  })

  it('большой originalFile не хранится; при нескольких результатах в событии чужой путь не применяется', () => {
    let s = reduceClaude(initialClaude(), edit, 1)
    const big = 'x\n'.repeat(40_000)
    s = reduceClaude(s, result({ filePath: '/p/a.ts', originalFile: big, structuredPatch: [{ oldStart: 1, newStart: 1, lines: ['-l2', '+L2'] }] }), 2)
    const it0 = s.items[0]
    expect(it0.type === 'action' && it0.diff?.original).toBeUndefined()
    expect(it0.type === 'action' && it0.diff?.hunks).toHaveLength(1)
    let t = reduceClaude(initialClaude(), edit, 1)
    const two = result({ filePath: '/other', structuredPatch: [{ oldStart: 1, newStart: 1, lines: ['-a', '+b'] }] })
    two.message.content.push({ type: 'tool_result', tool_use_id: 'x9', content: 'ok' })
    t = reduceClaude(t, two, 2)
    const it1 = t.items[0]
    expect(it1.type === 'action' && it1.diff?.hunks).toBeUndefined()
  })

  it('Write нового файла — created', () => {
    const w = { ...edit, message: { model: 'm', content: [{ type: 'tool_use', id: 'e1', name: 'Write', input: { file_path: '/p/a.ts', content: 'a\n' } }] } }
    let s = reduceClaude(initialClaude(), w, 1)
    s = reduceClaude(s, result({ type: 'create', filePath: '/p/a.ts', content: 'a\n', structuredPatch: [] }), 2)
    expect(s.items[0]).toMatchObject({ diff: { created: true, after: 'a\n' } })
  })
})

describe('DiffView', () => {
  const d: FileDiff = {
    path: '/p/a.ts',
    before: '',
    after: '',
    original: file(20),
    hunks: [{ oldStart: 9, newStart: 9, lines: [' const y = 2', '-l10', '+const x = 1', ' l11'] }],
  }

  it('номера строк, подсветка по расширению, свёрнутые куски разворачиваются', () => {
    const { container } = render(<DiffView diff={d} />)
    expect(container.querySelector('.dv-body')).not.toHaveClass('nonum')
    // Контекст — с подсветкой, изменённые строки — сплошным цветом (макет 02 .diff .a/.d).
    expect(container.querySelector('.dl.n .hljs-keyword')?.textContent).toBe('const')
    expect(container.querySelector('.dl.a [class^="hljs"], .dl.d [class^="hljs"]')).toBeNull()
    const gaps = screen.getAllByRole('button', { name: /без изменений/ })
    expect(gaps.map((g) => g.textContent)).toEqual(['… 6 строк без изменений', '… 7 строк без изменений'])
    const before = container.querySelectorAll('.dl:not(.gap)').length
    fireEvent.click(gaps[0])
    expect(container.querySelectorAll('.dl:not(.gap)').length).toBe(before + 6)
    expect(container.querySelector('.dl .dn')?.textContent).toBe('1')
  })

  it('развёрнутый кусок не пересоздаёт строки ниже', () => {
    const { container } = render(<DiffView diff={d} />)
    const row = Array.from(container.querySelectorAll('.dl.a'))[0]
    fireEvent.click(screen.getAllByRole('button', { name: /без изменений/ })[0])
    expect(container.querySelector('.dl.a')).toBe(row)
  })

  it('путь — относительно каталога сессии, полный — в подсказке; копируется полный', () => {
    expect(shownPath('/w/src/Form.tsx', '/w')).toBe('src/Form.tsx')
    expect(shownPath('/w/src/Form.tsx', '/w/')).toBe('src/Form.tsx')
    expect(shownPath('/wx/a.ts', '/w')).toBe('/wx/a.ts')
    expect(shownPath('/elsewhere/a.ts', '/w')).toBe('/elsewhere/a.ts')
    expect(shownPath('/w/a.ts', null)).toBe('/w/a.ts')
    const { container } = render(<DiffView diff={d} cwd="/p" />)
    const b = container.querySelector('.dv-path')!
    expect(b.textContent).toBe('a.ts')
    expect(b.getAttribute('title')).toBe('/p/a.ts')
  })

  it('«Открыть в редакторе» — preview_open с первой изменённой строкой; «Копировать путь» — полный', async () => {
    const writeText = vi.fn((_t: string) => Promise.resolve())
    Object.assign(navigator, { clipboard: { writeText } })
    render(<DiffView diff={d} cwd="/p" />)
    fireEvent.click(screen.getByRole('button', { name: 'Открыть в редакторе' }))
    expect(invoke).toHaveBeenCalledWith('preview_open', { path: '/p/a.ts', how: 'editor', line: 10 })
    fireEvent.click(screen.getByRole('button', { name: 'Копировать путь' }))
    expect(writeText).toHaveBeenCalledWith('/p/a.ts')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Скопировано' })).toBeInTheDocument())
  })

  it('длинный вид обрезан до «Показать ещё N строк»', () => {
    const big: FileDiff = { path: '/p/b.txt', before: '', after: file(DIFF_SHOWN + 15), created: true }
    const { container } = render(<DiffView diff={big} />)
    expect(container.querySelectorAll('.dl.a')).toHaveLength(DIFF_SHOWN)
    fireEvent.click(screen.getByRole('button', { name: 'Показать ещё 15 строк' }))
    expect(container.querySelectorAll('.dl.a')).toHaveLength(DIFF_SHOWN + 15)
  })
})
