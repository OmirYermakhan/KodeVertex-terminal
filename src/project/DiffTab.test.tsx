import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let text = ''
let fail: string | null = null
const diff = vi.fn(async (_root: string, _rel: string, _rev: string | null, _old?: string | null): Promise<string> => {
  if (fail) throw fail
  return text
})
vi.mock('./api', () => ({
  gitDiff: (root: string, rel: string, rev: string | null, old?: string | null) => diff(root, rel, rev, old),
}))

const { default: DiffTab, DIFF_TAB_SHOWN } = await import('./DiffTab')
const { useProject } = await import('./store')

const REL = 'app/src/main/java/com/shop/payments/PaymentService.kt'
const HASH = 'a41c9e2'.padEnd(40, '7')
// Как в макете 07, окно 2: два куска, между ними 14 строк без изменений.
const LOCAL = `diff --git a/${REL} b/${REL}
index 1111111..2222222 100644
--- a/${REL}
+++ b/${REL}
@@ -6,5 +6,7 @@
 class PaymentService(
     private val api: PaymentApi,
+    private val retry: RetryPolicy = RetryPolicy(3),
 ) {
-    suspend fun charge(order: Order): Receipt = api.charge(order.id, order.total)
+    suspend fun charge(order: Order): Receipt =
+        retry.run { api.charge(order.id, order.total) }

@@ -25,1 +27,1 @@
-    fun refund(id: String) = api.refund(id, null)
+    fun refund(id: String) = api.refund(id)
`
const NEW_FILE = (n: number) =>
  `diff --git a/x.kt b/x.kt
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/x.kt
@@ -0,0 +1,${n} @@
${Array.from({ length: n }, (_, i) => `+line ${i + 1}`).join('\n')}
`

const dls = () => Array.from(document.querySelectorAll('.dvw .dl')) as HTMLElement[]
const cells = (l: HTMLElement) => Array.from(l.querySelectorAll('.g, .mk')).map((x) => x.textContent)

describe('DiffTab', () => {
  beforeEach(() => {
    text = LOCAL
    fail = null
    diff.mockClear()
    useProject.setState({ root: '/w/shop-app', changes: [], tabs: [{ kind: 'diff', rel: REL, rev: null }], active: 0 })
  })

  it('локальные: заголовок — путь, +a −d, «HEAD → рабочая копия», «Открыть файл»', async () => {
    render(<DiffTab rel={REL} rev={null} />)
    await waitFor(() => expect(dls().length).toBeGreaterThan(0))
    expect(diff).toHaveBeenCalledWith('/w/shop-app', REL, null, null)
    const h = document.querySelector('.dvh') as HTMLElement
    expect(h.querySelector('b')?.textContent).toBe(REL)
    expect(h.querySelector('.pa')?.textContent).toBe('+4')
    expect(h.querySelector('.pd')?.textContent).toBe('−2')
    expect(h.querySelector('.ro')?.textContent).toBe('HEAD → рабочая копия')
    fireEvent.click(screen.getByRole('button', { name: 'Открыть файл' }))
    expect(useProject.getState().tabs[1]).toEqual({ kind: 'file', rel: REL })
  })

  it('строки: два номера, метка, классы a/d; между кусками — «… N строк без изменений»', async () => {
    render(<DiffTab rel={REL} rev={null} />)
    await waitFor(() => expect(dls().length).toBeGreaterThan(0))
    expect(dls().map((l) => l.className)).toEqual(['dl', 'dl', 'dl a', 'dl', 'dl d', 'dl a', 'dl a', 'dl', 'dl gap', 'dl d', 'dl a'])
    expect(cells(dls()[0])).toEqual(['6', '6', ' '])
    expect(cells(dls()[2])).toEqual(['', '8', '+'])
    expect(cells(dls()[4])).toEqual(['9', '', '−'])
    expect(cells(dls()[7])).toEqual(['10', '12', ' '])
    expect(dls()[8].textContent).toBe('… 14 строк без изменений')
    expect(dls()[2].textContent).toBe('8+    private val retry: RetryPolicy = RetryPolicy(3),')
  })

  it('коммит, новый файл: «+N» без «−0», «новый файл в <хэш>», «Копировать хэш»', async () => {
    text = NEW_FILE(8)
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(<DiffTab rel="x.kt" rev={HASH} />)
    await waitFor(() => expect(dls()).toHaveLength(8))
    expect(diff).toHaveBeenCalledWith('/w/shop-app', 'x.kt', HASH, null)
    expect(document.querySelector('.dvh .pa')?.textContent).toBe('+8')
    expect(document.querySelector('.dvh .pd')).toBeNull()
    expect(document.querySelector('.dvh .ro')?.textContent).toBe('новый файл в a41c9e2')
    fireEvent.click(screen.getByRole('button', { name: 'Копировать хэш' }))
    expect(writeText).toHaveBeenCalledWith(HASH)
    expect(await screen.findByRole('button', { name: 'Скопировано' })).toBeInTheDocument()
  })

  it('коммит, изменённый файл — плашка с коротким хэшем', async () => {
    render(<DiffTab rel={REL} rev={HASH} />)
    await waitFor(() => expect(dls().length).toBeGreaterThan(0))
    expect(document.querySelector('.dvh .ro')?.textContent).toBe('a41c9e2')
  })

  it('длинный — «… ещё N строк · Показать всё»', async () => {
    text = NEW_FILE(DIFF_TAB_SHOWN + 80)
    render(<DiffTab rel="x.kt" rev={HASH} />)
    await waitFor(() => expect(dls()).toHaveLength(DIFF_TAB_SHOWN + 1))
    const more = dls()[DIFF_TAB_SHOWN]
    expect(more.textContent).toBe('… ещё 80 строк · Показать всё')
    fireEvent.click(more)
    expect(dls()).toHaveLength(DIFF_TAB_SHOWN + 80)
  })

  it('урезанный — последняя строка «Изменения урезаны: больше 4 МБ»', async () => {
    text = NEW_FILE(3) + '\\ Изменения урезаны: больше 4 МБ\n'
    render(<DiffTab rel="x.kt" rev={null} />)
    await waitFor(() => expect(dls()).toHaveLength(4))
    expect(dls()[3]).toHaveClass('dl gap')
    expect(dls()[3].textContent).toBe('Изменения урезаны: больше 4 МБ')
  })

  it('пусто, бинарный, ошибка — сообщения', async () => {
    text = ''
    const { unmount } = render(<DiffTab rel={REL} rev={null} />)
    expect(await screen.findByText('Изменений нет')).toBeInTheDocument()
    unmount()
    text = 'diff --git a/i.png b/i.png\nBinary files a/i.png and b/i.png differ\n'
    const r2 = render(<DiffTab rel="i.png" rev={null} />)
    expect(await screen.findByText('Бинарный файл')).toBeInTheDocument()
    r2.unmount()
    fail = 'git: таймаут'
    render(<DiffTab rel={REL} rev={null} />)
    expect(await screen.findByText('git: таймаут')).toBeInTheDocument()
  })

  it('переименованный: прежний путь — в git_diff и в заголовке «old → new»', async () => {
    render(<DiffTab rel="src/New.kt" rev={HASH} oldPath="src/Old.kt" />)
    await waitFor(() => expect(dls().length).toBeGreaterThan(0))
    expect(diff).toHaveBeenCalledWith('/w/shop-app', 'src/New.kt', HASH, 'src/Old.kt')
    expect(document.querySelector('.dvh b')?.textContent).toBe('src/Old.kt → src/New.kt')
  })

  it('локально удалённый — без «Открыть файл»', async () => {
    act(() => useProject.setState({ changes: [{ path: REL, status: 'D', add: 0, del: 9 }] }))
    render(<DiffTab rel={REL} rev={null} />)
    await waitFor(() => expect(dls().length).toBeGreaterThan(0))
    expect(screen.queryByRole('button', { name: 'Открыть файл' })).toBeNull()
  })

  it('большой неотслеживаемый — последняя строка «Файл усечён»', async () => {
    text = NEW_FILE(3) + '\\ Файл усечён\n'
    render(<DiffTab rel="x.kt" rev={null} />)
    await waitFor(() => expect(dls()).toHaveLength(4))
    expect(dls()[3]).toHaveClass('dl gap')
    expect(dls()[3].textContent).toBe('Файл усечён')
  })

  it('локальные перечитываются при обновлении статуса', async () => {
    render(<DiffTab rel={REL} rev={null} />)
    await waitFor(() => expect(diff).toHaveBeenCalledTimes(1))
    act(() => useProject.setState({ changes: [{ path: REL, status: 'M' }] }))
    await waitFor(() => expect(diff).toHaveBeenCalledTimes(2))
  })
})
