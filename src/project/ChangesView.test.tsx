import { fireEvent, render, screen } from '@testing-library/react'
import { act } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Change } from './api'
import ChangesView from './ChangesView'
import { commitSummary, filesWord, localSummary, shortDir, statText } from './changeRow'
import { useProject } from './store'

const P = 'app/src/main/java/com/shop/payments'
// Как в макете 07, окно 2.
const CHANGES: Change[] = [
  { path: `${P}/PaymentApi.kt`, status: 'M', add: 4, del: 1 },
  { path: `${P}/PaymentService.kt`, status: 'A', add: 18, del: 2 },
  { path: `${P}/LegacyPay.kt`, status: 'D', add: 0, del: 64 },
  { path: 'app/src/main/AndroidManifest.xml', status: 'M', add: 1, del: 0 },
  { path: `${P}/RetryPolicy.kt`, status: '?' },
]

const rows = () => Array.from(document.querySelectorAll('.ch')) as HTMLElement[]

describe('helpers', () => {
  it('каталог строки: длинный — «первая/…/последняя», короткий — целиком', () => {
    expect(shortDir(`${P}/PaymentApi.kt`)).toBe('app/…/payments')
    expect(shortDir('app/src/main/AndroidManifest.xml')).toBe('app/src/main')
    expect(shortDir('README.md')).toBe('')
  })
  it('счётчик строки: «+a −d» без нулей, неотслеживаемый — «новый»', () => {
    expect(CHANGES.map(statText)).toEqual(['+4 −1', '+18 −2', '−64', '+1', 'новый'])
    expect(statText({ path: 'b.png', status: 'M' })).toBe('')
  })
  it('склонение «файл»', () => {
    expect([1, 2, 4, 5, 11, 21, 22, 25].map((n) => `${n} ${filesWord(n)}`)).toEqual([
      '1 файл', '2 файла', '4 файла', '5 файлов', '11 файлов', '21 файл', '22 файла', '25 файлов',
    ])
  })
  it('строка состояния: «N изменено · M новый», коммит — «хэш · N файла · +a −d»', () => {
    expect(localSummary(CHANGES)).toBe('4 изменено · 1 новый')
    expect(localSummary(CHANGES.slice(0, 2))).toBe('2 изменено')
    expect(localSummary([CHANGES[4], { ...CHANGES[4], path: 'x' }])).toBe('2 новых')
    expect(localSummary(CHANGES, 1234)).toBe('4 изменено · 1235 новых')
    expect(localSummary([])).toBeNull()
    expect(localSummary(null)).toBeNull()
    expect(
      commitSummary('a41c9e2', [
        { path: 'a', status: 'A', add: 52, del: 0 },
        { path: 'b', status: 'A', add: 88, del: 0 },
        { path: 'c', status: 'M', add: 6, del: 1 },
      ]),
    ).toBe('a41c9e2 · 3 файла · +146 −1')
  })
})

describe('ChangesView', () => {
  beforeEach(() =>
    useProject.setState({
      root: '/w/shop-app',
      changes: CHANGES,
      notGit: false,
      gitError: null,
      tabs: [],
      active: 0,
      moreUntracked: 0,
      changesSel: null,
      changesClosed: new Set(),
      claudeTouched: new Set([`${P}/PaymentApi.kt`, `${P}/PaymentService.kt`, `${P}/LegacyPay.kt`, `${P}/RetryPolicy.kt`]),
    }),
  )

  it('группы со счётчиками, строки: значок, имя цветом статуса, каталог, «+a −d»', () => {
    render(<ChangesView />)
    const grps = Array.from(document.querySelectorAll('.grp')).map((g) => g.textContent)
    expect(grps).toEqual(['▾Изменения 4 файла', '▾Не отслеживаются 1 файл'])
    expect(rows().map((r) => r.className)).toEqual(['ch mod', 'ch add', 'ch del', 'ch mod', 'ch new'])
    expect(rows().map((r) => r.textContent)).toEqual([
      'KPaymentApi.ktapp/…/payments+4 −1',
      'KPaymentService.ktapp/…/payments+18 −2',
      'KLegacyPay.ktapp/…/payments−64',
      'XAndroidManifest.xmlapp/src/main+1',
      'KRetryPolicy.ktapp/…/paymentsновый',
    ])
    expect(rows()[0].querySelector('.fi.pfi.kt')).not.toBeNull()
  })

  it('подвал: «+A −D · N файлов» и «Claude менял K из N»', () => {
    render(<ChangesView />)
    expect(document.querySelector('.twf')?.textContent).toBe('+23 −67 · 5 файловClaude менял 4 из 5')
    act(() => useProject.setState({ claudeTouched: new Set() }))
    expect(document.querySelector('.twf')?.textContent).toBe('+23 −67 · 5 файлов')
  })

  it('клик — выбор и изменения файла справа', () => {
    render(<ChangesView />)
    fireEvent.click(rows()[1])
    expect(rows()[1]).toHaveClass('sel')
    expect(useProject.getState().tabs).toEqual([{ kind: 'diff', rel: `${P}/PaymentService.kt`, rev: null }])
  })

  it('клавиши: ↑↓ выбор, ↵ изменения, ⌘↓ файл', () => {
    render(<ChangesView />)
    const host = screen.getByTestId('changes-view')
    fireEvent.keyDown(host, { key: 'ArrowDown' })
    fireEvent.keyDown(host, { key: 'ArrowDown' })
    expect(rows()[1]).toHaveClass('sel')
    fireEvent.keyDown(host, { key: 'ArrowUp' })
    expect(rows()[0]).toHaveClass('sel')
    fireEvent.keyDown(host, { key: 'Enter' })
    expect(useProject.getState().tabs).toEqual([{ kind: 'diff', rel: `${P}/PaymentApi.kt`, rev: null }])
    fireEvent.keyDown(host, { key: 'ArrowDown', metaKey: true })
    expect(useProject.getState().tabs[1]).toEqual({ kind: 'file', rel: `${P}/PaymentApi.kt` })
  })

  it('переименованный — изменения с прежним путём; удалённый — ⌘↓ ничего не делает', () => {
    act(() =>
      useProject.setState({
        changes: [
          { path: 'src/New.kt', oldPath: 'src/Old.kt', status: 'R', add: 1, del: 1 },
          { path: 'src/Gone.kt', status: 'D', add: 0, del: 3 },
        ],
      }),
    )
    render(<ChangesView />)
    fireEvent.click(rows()[0])
    expect(useProject.getState().tabs).toEqual([{ kind: 'diff', rel: 'src/New.kt', rev: null, oldPath: 'src/Old.kt' }])
    fireEvent.click(rows()[1])
    fireEvent.keyDown(screen.getByTestId('changes-view'), { key: 'ArrowDown', metaKey: true })
    expect(useProject.getState().tabs.some((t) => t.kind === 'file')).toBe(false)
  })

  it('группа сворачивается по клику на заголовок', () => {
    render(<ChangesView />)
    fireEvent.click(document.querySelectorAll('.grp')[0])
    expect(document.querySelectorAll('.grp')[0].textContent).toBe('▸Изменения 4 файла')
    expect(rows()).toHaveLength(1)
  })

  it('пусто, не git, ошибка — сообщения', () => {
    act(() => useProject.setState({ changes: [] }))
    const { rerender } = render(<ChangesView />)
    expect(screen.getByText('Изменений нет')).toBeInTheDocument()
    expect(document.querySelector('.twf')).toBeNull()
    act(() => useProject.setState({ changes: [], notGit: true }))
    rerender(<ChangesView />)
    expect(screen.getByText('Не git-репозиторий')).toBeInTheDocument()
    act(() => useProject.setState({ changes: null, notGit: false, gitError: 'git: таймаут' }))
    rerender(<ChangesView />)
    expect(screen.getByText('git: таймаут')).toBeInTheDocument()
  })

  it('неотслеживаемых сверх потолка — строка «ещё N не отслеживаются», в счётчиках — все', () => {
    act(() => useProject.setState({ moreUntracked: 1234 }))
    render(<ChangesView />)
    expect(document.querySelectorAll('.grp')[1].textContent).toBe('▾Не отслеживаются 1235 файлов')
    expect(rows()).toHaveLength(5)
    expect(document.querySelector('.ch-more')?.textContent).toBe('ещё 1234 не отслеживаются')
    expect(document.querySelector('.twf')?.textContent).toBe('+23 −67 · 1239 файловClaude менял 4 из 1239')
  })

  it('выбор и свёрнутые группы переживают смену окна инструмента', () => {
    const { unmount } = render(<ChangesView />)
    fireEvent.click(rows()[1])
    fireEvent.click(document.querySelectorAll('.grp')[1])
    unmount()
    render(<ChangesView />)
    expect(rows()[1]).toHaveClass('sel')
    expect(document.querySelectorAll('.grp')[1].textContent).toBe('▸Не отслеживаются 1 файл')
  })
})
