import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Change, Commit } from './api'

let commits: Commit[] = []
let files: Record<string, Change[]> = {}
let logFail: string | null = null
const log = vi.fn(async (_root: string, skip: number, limit: number): Promise<Commit[]> => {
  if (logFail) throw logFail
  return commits.slice(skip, skip + limit)
})
const commitFiles = vi.fn(async (_root: string, hash: string): Promise<Change[]> => files[hash] ?? [])
vi.mock('./api', () => ({
  gitLog: (root: string, skip: number, limit: number) => log(root, skip, limit),
  gitCommitFiles: (root: string, hash: string) => commitFiles(root, hash),
}))

const { default: GitLog, commitDate, parseRefs, LOG_PAGE } = await import('./GitLog')
const { useProject } = await import('./store')

// «Сейчас» — 14 нояб. 2026, 16:00 по местному времени.
const NOW = new Date(2026, 10, 14, 16, 0)
const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo, d, h, mi).getTime() / 1000

const C = (hash: string, subject: string, time: number, refs: string[] = []): Commit => ({
  hash: hash.padEnd(40, '0'),
  short: hash,
  subject,
  author: 'Омир',
  time,
  refs,
  head: refs.some((r) => r.startsWith('HEAD')),
})

// Как в макете 07, окно 3.
const MOCK: Commit[] = [
  C('a41c9e2', 'Оплата: PaymentApi и экран оплаты', at(2026, 10, 14, 14, 20), ['HEAD -> feature/payments']),
  C('7d02b11', 'Корзина: пересчёт итога при скидке', at(2026, 10, 13, 19, 5)),
  C('e93f4a0', 'Слияние: каталог товаров', at(2026, 10, 13, 11, 40), ['main']),
  C('5be81c3', 'Каталог: фильтр по цене', at(2026, 10, 12, 9, 0)),
  C('01af7d9', 'Первая версия магазина', at(2026, 10, 10, 9, 0)),
]
const A41 = MOCK[0].hash
const A41_FILES: Change[] = [
  { path: 'app/src/main/java/com/shop/payments/PaymentApi.kt', status: 'A', add: 52, del: 0 },
  { path: 'app/src/main/java/com/shop/ui/PayScreen.kt', status: 'A', add: 88, del: 0 },
  { path: 'res/values/strings.xml', status: 'M', add: 6, del: 1 },
]

const cms = () => Array.from(document.querySelectorAll('.cm')) as HTMLElement[]
const chs = () => Array.from(document.querySelectorAll('.cfiles .ch')) as HTMLElement[]

describe('helpers', () => {
  it('дата: «сегодня 14:20», «вчера 19:05», «12 нояб.», прошлый год — с годом', () => {
    expect(commitDate(at(2026, 10, 14, 14, 20), NOW)).toBe('сегодня 14:20')
    expect(commitDate(at(2026, 10, 14, 0, 5), NOW)).toBe('сегодня 00:05')
    expect(commitDate(at(2026, 10, 13, 19, 5), NOW)).toBe('вчера 19:05')
    expect(commitDate(at(2026, 10, 12, 23, 59), NOW)).toBe('12 нояб.')
    expect(commitDate(at(2026, 0, 3, 10, 0), NOW)).toBe('3 янв.')
    expect(commitDate(at(2026, 4, 9, 10, 0), NOW)).toBe('9 мая')
    expect(commitDate(at(2025, 10, 12, 10, 0), NOW)).toBe('12 нояб. 2025')
    // 1 января: «вчера» — 31 декабря прошлого года.
    expect(commitDate(at(2026, 11, 31, 22, 0), new Date(2027, 0, 1, 9, 0))).toBe('вчера 22:00')
  })
  it('метки: HEAD отдельно, ветки, теги без «tag:»', () => {
    expect(parseRefs(['HEAD -> feature/payments', 'origin/main', 'tag: v1.0'])).toEqual([
      { name: 'HEAD', head: true },
      { name: 'feature/payments', head: false },
      { name: 'origin/main', head: false },
      { name: 'v1.0', head: false },
    ])
    expect(parseRefs(['HEAD'])).toEqual([{ name: 'HEAD', head: true }])
    expect(parseRefs([])).toEqual([])
  })
})

describe('GitLog', () => {
  beforeEach(() => {
    commits = MOCK
    files = { [A41]: A41_FILES }
    logFail = null
    log.mockClear()
    commitFiles.mockClear()
    useProject.setState({
      tool: 'git',
      root: '/w/shop-app',
      changes: [
        { path: 'a.kt', status: 'M', add: 1, del: 0 },
        { path: 'b.kt', status: 'M', add: 1, del: 0 },
        { path: 'c.kt', status: 'A', add: 1, del: 0 },
        { path: 'd.kt', status: 'D', add: 0, del: 1 },
        { path: 'e.kt', status: '?' },
      ],
      notGit: false,
      gitError: null,
      tabs: [],
      active: 0,
      commitStat: null,
    })
  })

  it('строка локальных изменений: «● Локальные изменения · N файлов», ⌥⌘0; клик — окно «Изменения»', async () => {
    render(<GitLog now={NOW} />)
    await waitFor(() => expect(cms()).toHaveLength(5))
    const local = document.querySelector('.local') as HTMLElement
    expect(local.textContent).toBe('● Локальные изменения · 5 файлов⌥⌘0')
    fireEvent.click(local)
    expect(useProject.getState().tool).toBe('changes')
  })

  it('коммиты: сообщение, метки HEAD и веток, короткий хэш, дата', async () => {
    render(<GitLog now={NOW} />)
    await waitFor(() => expect(cms()).toHaveLength(5))
    expect(log).toHaveBeenCalledWith('/w/shop-app', 0, LOG_PAGE)
    expect(LOG_PAGE).toBe(100)
    const c0 = cms()[0]
    expect(c0.querySelector('.gr i')).not.toBeNull()
    expect(c0.querySelector('.msg')?.textContent).toBe('Оплата: PaymentApi и экран оплаты')
    expect(Array.from(c0.querySelectorAll('.meta > span')).map((s) => [s.className, s.textContent])).toEqual([
      ['ref head', 'HEAD'],
      ['ref', 'feature/payments'],
      ['h', 'a41c9e2'],
      ['', 'сегодня 14:20'],
    ])
    expect(cms().map((c) => c.querySelector('.meta')?.textContent)).toEqual([
      'HEADfeature/paymentsa41c9e2сегодня 14:20',
      '7d02b11вчера 19:05',
      'maine93f4a0вчера 11:40',
      '5be81c312 нояб.',
      '01af7d910 нояб.',
    ])
  })

  it('клик по коммиту раскрывает его файлы; клик по файлу — изменения в этом коммите; строка состояния', async () => {
    render(<GitLog now={NOW} />)
    await waitFor(() => expect(cms()).toHaveLength(5))
    fireEvent.click(cms()[0])
    expect(cms()[0]).toHaveClass('cm sel')
    await waitFor(() => expect(chs()).toHaveLength(3))
    expect(commitFiles).toHaveBeenCalledWith('/w/shop-app', A41)
    expect(chs().map((r) => [r.className, r.textContent])).toEqual([
      ['ch add', 'KPaymentApi.ktapp/…/payments+52'],
      ['ch add', 'KPayScreen.ktapp/…/ui+88'],
      ['ch mod', 'Xstrings.xmlres/values+6 −1'],
    ])
    expect(useProject.getState().commitStat).toBe('a41c9e2 · 3 файла · +146 −1')
    fireEvent.click(chs()[1])
    expect(chs()[1]).toHaveClass('sel')
    expect(useProject.getState().tabs).toEqual([{ kind: 'diff', rel: 'app/src/main/java/com/shop/ui/PayScreen.kt', rev: A41 }])
    // Повторный клик по коммиту — свернуть.
    fireEvent.click(cms()[0])
    expect(chs()).toHaveLength(0)
  })

  it('клавиши: ↓ коммит, → файлы, → в первый файл, ↵ изменения, ← назад к коммиту', async () => {
    render(<GitLog now={NOW} />)
    await waitFor(() => expect(cms()).toHaveLength(5))
    const host = screen.getByTestId('git-log')
    fireEvent.keyDown(host, { key: 'ArrowDown' }) // локальные изменения
    fireEvent.keyDown(host, { key: 'ArrowDown' })
    expect(cms()[0]).toHaveClass('sel')
    fireEvent.keyDown(host, { key: 'ArrowRight' })
    await waitFor(() => expect(chs()).toHaveLength(3))
    fireEvent.keyDown(host, { key: 'ArrowRight' })
    expect(chs()[0]).toHaveClass('sel')
    fireEvent.keyDown(host, { key: 'ArrowDown' })
    fireEvent.keyDown(host, { key: 'Enter' })
    expect(useProject.getState().tabs).toEqual([{ kind: 'diff', rel: 'app/src/main/java/com/shop/ui/PayScreen.kt', rev: A41 }])
    fireEvent.keyDown(host, { key: 'ArrowLeft' })
    expect(cms()[0]).toHaveClass('sel')
    fireEvent.keyDown(host, { key: 'ArrowLeft' })
    expect(chs()).toHaveLength(0)
    fireEvent.keyDown(host, { key: 'ArrowUp' })
    fireEvent.keyDown(host, { key: 'Enter' })
    expect(useProject.getState().tool).toBe('changes')
  })

  it('догрузка по 100 при прокрутке к концу; неполная страница — конец лога', async () => {
    commits = Array.from({ length: 150 }, (_, i) => C(`c${String(i).padStart(6, '0')}`, `Коммит ${i}`, at(2026, 9, 1, 10, 0)))
    render(<GitLog now={NOW} />)
    await waitFor(() => expect(cms()).toHaveLength(100))
    const host = screen.getByTestId('git-log')
    Object.defineProperty(host, 'scrollHeight', { configurable: true, value: 2400 })
    Object.defineProperty(host, 'clientHeight', { configurable: true, value: 600 })
    host.scrollTop = 300
    fireEvent.scroll(host)
    expect(log).toHaveBeenCalledTimes(1)
    host.scrollTop = 1700
    fireEvent.scroll(host)
    await waitFor(() => expect(cms()).toHaveLength(150))
    expect(log).toHaveBeenLastCalledWith('/w/shop-app', 100, 100)
    fireEvent.scroll(host)
    expect(log).toHaveBeenCalledTimes(2)
  })

  it('новый коммит после обновления — лог перечитывается', async () => {
    render(<GitLog now={NOW} />)
    await waitFor(() => expect(cms()).toHaveLength(5))
    commits = [C('ffff001', 'Новый', at(2026, 10, 14, 15, 0)), ...MOCK]
    act(() => useProject.setState({ changes: [] }))
    await waitFor(() => expect(cms()).toHaveLength(6))
    expect(cms()[0].querySelector('.msg')?.textContent).toBe('Новый')
    expect(document.querySelector('.local')).toBeNull()
  })

  it('не git и пустой лог — сообщения', async () => {
    commits = []
    const { unmount } = render(<GitLog now={NOW} />)
    expect(await screen.findByText('Коммитов ещё нет')).toBeInTheDocument()
    unmount()
    logFail = 'not-git'
    act(() => useProject.setState({ notGit: true, changes: [] }))
    render(<GitLog now={NOW} />)
    expect(await screen.findByText('Не git-репозиторий')).toBeInTheDocument()
  })
})
