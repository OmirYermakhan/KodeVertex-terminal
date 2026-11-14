import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Change, FileText } from './api'

let files: Record<string, FileText> = {}
let diffs: Record<string, string> = {}
const read = vi.fn(async (_root: string, rel: string): Promise<FileText> => files[rel] ?? { kind: 'missing' })
const diff = vi.fn(async (_root: string, rel: string, _rev: string | null): Promise<string> => diffs[rel] ?? '')
vi.mock('./api', () => ({
  projectRead: (root: string, rel: string) => read(root, rel),
  gitDiff: (root: string, rel: string, rev: string | null) => diff(root, rel, rev),
}))
const openPath = vi.fn(async () => {})
vi.mock('../attach/preview/api', () => ({ openPath: (...a: unknown[]) => openPath(...(a as [])) }))

const { default: FileView, gutterMarks, crumbs, CHUNK } = await import('./FileView')
const { useProject } = await import('./store')
const { parseUnified } = await import('./unified')

const REL = 'app/src/main/java/com/shop/payments/PaymentService.kt'
const SRC = [
  'package com.shop.payments',
  '',
  'import kotlinx.coroutines.delay',
  '',
  '/** Оплата заказа: API + ретраи. */',
  'class PaymentService(',
  '    private val api: PaymentApi,',
  '    private val retry: RetryPolicy = RetryPolicy(3),',
  ') {',
  '    suspend fun charge(order: Order): Receipt =',
  '        retry.run { api.charge(order.id, order.total) }',
  '',
  '    fun refund(id: String) = api.refund(id)',
  '}',
]
// Как в макете 07: строка 8 добавлена, 10 изменена, 11 добавлена.
const DIFF = `diff --git a/${REL} b/${REL}
--- a/${REL}
+++ b/${REL}
@@ -5,8 +5,10 @@
 /** Оплата заказа: API + ретраи. */
 class PaymentService(
     private val api: PaymentApi,
+    private val retry: RetryPolicy = RetryPolicy(3),
 ) {
-    suspend fun charge(order: Order): Receipt = api.charge(order.id, order.total)
+    suspend fun charge(order: Order): Receipt =
+        retry.run { api.charge(order.id, order.total) }

     fun refund(id: String) = api.refund(id)
`

const text = (lines: string[], truncated = false): FileText => ({ kind: 'text', lines, truncated, size: 100 })
const lns = () => Array.from(document.querySelectorAll('.code .ln')) as HTMLElement[]
const gutter = (l: HTMLElement) => l.querySelector('.g')?.textContent
const mark = (l: HTMLElement) => l.querySelector('.vc')?.className

beforeEach(() => {
  files = { [REL]: text(SRC) }
  diffs = { [REL]: DIFF }
  read.mockClear()
  diff.mockClear()
  openPath.mockClear()
  useProject.setState({
    root: '/Users/me/shop-app',
    changes: [{ path: REL, status: 'M' }],
    notGit: false,
    tabs: [{ kind: 'file', rel: REL }],
    active: 0,
    focusLine: null,
    cursors: {},
  })
})

async function mount(rel = REL) {
  render(<FileView rel={rel} />)
  await waitFor(() => expect(read).toHaveBeenCalled())
  await act(async () => {})
}

describe('gutterMarks', () => {
  it('добавленные — a, заменившие удалённые — m (по парам в блоке)', () => {
    const m = gutterMarks(parseUnified(DIFF).hunks)
    expect([...m.entries()]).toEqual([
      [8, 'a'],
      [10, 'm'],
      [11, 'a'],
    ])
  })
  it('только удаление — без отметок', () => {
    const m = gutterMarks(parseUnified('@@ -1,2 +1,1 @@\n a\n-b\n').hunks)
    expect(m.size).toBe(0)
  })
})

describe('crumbs', () => {
  it('длинный путь: первый › … › последний каталог › имя', () => {
    expect(crumbs(REL)).toEqual({ dirs: 'app › … › payments › ', name: 'PaymentService.kt' })
  })
  it('короткий путь — целиком', () => {
    expect(crumbs('a/b/c.kt')).toEqual({ dirs: 'a › b › ', name: 'c.kt' })
    expect(crumbs('c.kt')).toEqual({ dirs: '', name: 'c.kt' })
  })
})

describe('FileView', () => {
  it('строка над кодом: крошки, «только чтение», «Открыть в редакторе»', async () => {
    await mount()
    expect(document.querySelector('.ebar .crumb')?.textContent).toBe('app › … › payments › PaymentService.kt')
    expect(document.querySelector('.ebar .crumb b')?.textContent).toBe('PaymentService.kt')
    expect(document.querySelector('.ebar .ro')?.textContent).toBe('🔒 только чтение')
    fireEvent.click(screen.getByRole('button', { name: 'Открыть в редакторе' }))
    expect(openPath).toHaveBeenCalledWith('/Users/me/shop-app/' + REL, 'editor', 1)
  })

  it('номера строк и подсветка', async () => {
    await mount()
    const l = lns()
    expect(l).toHaveLength(14)
    expect(l.map(gutter)).toEqual(Array.from({ length: 14 }, (_, i) => String(i + 1)))
    expect(l[0].textContent).toBe('1package com.shop.payments')
    expect(l[0].querySelector('.hljs-keyword')?.textContent).toBe('package')
    expect(read).toHaveBeenCalledWith('/Users/me/shop-app', REL)
  })

  it('полоски изменений из diff с HEAD на нужных строках', async () => {
    await mount()
    await waitFor(() => expect(mark(lns()[7])).toBe('vc a'))
    expect(diff).toHaveBeenCalledWith('/Users/me/shop-app', REL, null)
    const l = lns()
    expect(mark(l[9])).toBe('vc m')
    expect(mark(l[10])).toBe('vc a')
    expect(l.filter((x) => mark(x) !== 'vc').map(gutter)).toEqual(['8', '10', '11'])
  })

  it('неотслеживаемый файл и не git — без полосок и без запроса diff', async () => {
    act(() => useProject.setState({ changes: [{ path: REL, status: '?' }] }))
    await mount()
    expect(diff).not.toHaveBeenCalled()
    expect(lns().every((x) => mark(x) === 'vc')).toBe(true)
  })

  it('клик по строке — текущая строка и курсор в хранилище', async () => {
    await mount()
    fireEvent.click(lns()[9])
    expect(lns()[9]).toHaveClass('ln', 'cur')
    expect(document.querySelectorAll('.ln.cur')).toHaveLength(1)
    expect(useProject.getState().cursors[REL]).toBe(10)
    fireEvent.click(screen.getByRole('button', { name: 'Открыть в редакторе' }))
    expect(openPath).toHaveBeenCalledWith('/Users/me/shop-app/' + REL, 'editor', 10)
  })

  it('большой файл — строка «Файл большой — показаны первые N строк · Открыть в редакторе»', async () => {
    files[REL] = text(SRC, true)
    await mount()
    const note = document.querySelector('.ed-note')
    expect(note?.textContent).toBe('Файл большой — показаны первые 14 строк · Открыть в редакторе')
  })

  it('бинарный и отсутствующий — свои сообщения, вкладка остаётся', async () => {
    files['img.png'] = { kind: 'binary', size: 2048 }
    const { unmount } = render(<FileView rel="img.png" />)
    await waitFor(() =>
      expect(document.querySelector('.ed-msg')?.textContent).toBe('Бинарный файл · 2.0 КБ · Открыть в редакторе'),
    )
    unmount()
    render(<FileView rel="gone.kt" />)
    expect(await screen.findByText('Файл удалён')).toBeInTheDocument()
  })

  it('файл удалили, пока открыт: после обновления — «Файл удалён»', async () => {
    await mount()
    expect(lns()).toHaveLength(14)
    delete files[REL]
    await act(async () => useProject.setState({ changes: [{ path: REL, status: 'D' }] }))
    expect(await screen.findByText('Файл удалён')).toBeInTheDocument()
    expect(useProject.getState().tabs).toHaveLength(1)
  })

  it('обновление changes перечитывает файл', async () => {
    await mount()
    files[REL] = text([...SRC, '// новая строка'])
    await act(async () => useProject.setState({ changes: [{ path: REL, status: 'M' } as Change] }))
    await waitFor(() => expect(lns()).toHaveLength(15))
  })

  it('20 000 строк: в DOM только видимое окно, подсветка кусками', async () => {
    files[REL] = text(Array.from({ length: 20000 }, (_, i) => `val x${i} = ${i}`), true)
    await mount()
    const n = lns().length
    expect(n).toBeGreaterThan(10)
    expect(n).toBeLessThan(CHUNK)
    expect(gutter(lns()[0])).toBe('1')
  })

  it('открытие со строкой — она текущая и в окне', async () => {
    files[REL] = text(Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`))
    act(() => useProject.getState().openFile(REL, 3000))
    await mount()
    const cur = document.querySelector('.ln.cur') as HTMLElement
    expect(gutter(cur)).toBe('3000')
    expect(useProject.getState().cursors[REL]).toBe(3000)
  })
})
