import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Change, DirList } from './api'

/** Дерево «на диске»: каталог → записи (как отдаёт project_list: папки первыми, без учёта регистра). */
let fs: Record<string, DirList> = {}
const list = vi.fn(async (_root: string, rel: string): Promise<DirList> => {
  const d = fs[rel]
  if (!d) throw new Error('нет каталога')
  return d
})
vi.mock('./api', () => ({ projectList: (root: string, rel: string) => list(root, rel) }))

const { default: ProjectTree } = await import('./ProjectTree')
const { useProject } = await import('./store')

const d = (name: string) => ({ name, isDir: true })
const f = (name: string) => ({ name, isDir: false })
const ls = (...entries: { name: string; isDir: boolean }[]): DirList => ({ entries, more: 0 })

const rows = () => Array.from(document.querySelectorAll('.tree .n')) as HTMLElement[]
const name = (r: Element | null | undefined) => r?.querySelector('.lbl')?.textContent
const row = (text: string) => rows().find((r) => name(r) === text)!
const tree = () => screen.getByTestId('project-tree')
const key = (k: string) => fireEvent.keyDown(tree(), { key: k })
const sel = () => name(document.querySelector('.tree .n.sel'))

const openFile = vi.fn()

beforeEach(() => {
  fs = {
    '': ls(d('.gradle'), d('app'), f('README.md'), f('settings.gradle.kts')),
    '.gradle': ls(f('cache.bin')),
    app: ls(d('src'), f('AndroidManifest.xml'), f('build.gradle.kts')),
    'app/src': ls(d('main')),
    'app/src/main': ls(d('java')),
    'app/src/main/java': ls(d('com')),
    'app/src/main/java/com': ls(d('shop')),
    'app/src/main/java/com/shop': ls(d('cart'), d('payments')),
    'app/src/main/java/com/shop/cart': ls(f('Cart.kt')),
    'app/src/main/java/com/shop/payments': ls(f('PaymentApi.kt'), f('RetryPolicy.kt')),
  }
  list.mockClear()
  openFile.mockClear()
  useProject.setState({ root: '/Users/me/projects/shop-app', changes: [], notGit: false, openFile })
})

async function mount(changes: Change[] = []) {
  act(() => useProject.setState({ changes }))
  render(<ProjectTree />)
  await screen.findByText('README.md')
}

describe('ProjectTree', () => {
  it('нет корня — тихая подсказка, без запросов', () => {
    useProject.setState({ root: null })
    render(<ProjectTree />)
    expect(rows()).toHaveLength(0)
    expect(list).not.toHaveBeenCalled()
  })

  it('корень: жирное имя и серый путь ~/…, раскрыт; отступы по 16px от 6px', async () => {
    await mount()
    const r = rows()[0]
    expect(r.querySelector('b')).toHaveTextContent('shop-app')
    expect(r.querySelector('.hint')).toHaveTextContent('~/projects/shop-app')
    expect(r.querySelector('.tw-a')).toHaveTextContent('▾')
    expect(r.style.paddingLeft).toBe('6px')
    expect(row('app').style.paddingLeft).toBe('22px')
    expect(row('app').querySelector('.tw-a')).toHaveTextContent('▸')
    expect(row('README.md').querySelector('.fi')).toHaveTextContent('M')
    expect(row('settings.gradle.kts').querySelector('.fi')).toHaveTextContent('G')
  })

  it('ленивое раскрытие: list — только при раскрытии; цепочка из одной папки — одной строкой', async () => {
    await mount()
    expect(list.mock.calls.map((c) => c[1])).toEqual([''])
    fireEvent.click(row('app'))
    await screen.findByText('AndroidManifest.xml')
    expect(list.mock.calls.map((c) => c[1])).toContain('app')
    expect(list.mock.calls.map((c) => c[1])).not.toContain('app/src')
    fireEvent.click(row('src'))
    const chain = await screen.findByText('src/main/java')
    expect(chain.closest('.n')!.querySelector('.fold')).toHaveClass('src')
    expect((chain.closest('.n') as HTMLElement).style.paddingLeft).toBe('38px')
    // цепочка кончается на корне исходников; ниже — новая, пакетом через точку
    expect(await screen.findByText('com.shop')).toBeInTheDocument()
    expect(row('com.shop').style.paddingLeft).toBe('54px')
    expect(row('com.shop').querySelector('.tw-a')).toHaveTextContent('▾')
    const names = rows().map(name)
    expect(names.slice(names.indexOf('com.shop') + 1, names.indexOf('com.shop') + 3)).toEqual(['cart', 'payments'])
    expect(row('cart').style.paddingLeft).toBe('70px')
    fireEvent.click(row('cart'))
    expect(await screen.findByText('Cart.kt')).toBeInTheDocument()
    expect(row('Cart.kt').style.paddingLeft).toBe('86px')
    // свернуть — дети исчезают
    fireEvent.click(row('app'))
    expect(screen.queryByText('AndroidManifest.xml')).toBeNull()
  })

  it('одномодульный проект: src/main/java в корне — одна строка, ниже com.shop', async () => {
    fs[''] = ls(d('src'), f('README.md'))
    fs.src = ls(d('main'))
    fs['src/main'] = ls(d('java'))
    fs['src/main/java'] = ls(d('com'))
    fs['src/main/java/com'] = ls(d('shop'))
    fs['src/main/java/com/shop'] = ls(d('cart'), d('payments'))
    await mount()
    fireEvent.click(row('src'))
    expect(await screen.findByText('src/main/java')).toBeInTheDocument()
    expect(row('src/main/java').style.paddingLeft).toBe('22px')
    expect(await screen.findByText('com.shop')).toBeInTheDocument()
    expect(row('com.shop').style.paddingLeft).toBe('38px')
    expect(row('cart').style.paddingLeft).toBe('54px')
  })

  it('после перечитывания папка из одной папки раскрывается цепочкой, как при раскрытии', async () => {
    await mount()
    fireEvent.click(row('.gradle'))
    await screen.findByText('cache.bin')
    fs['.gradle'] = ls(d('8.4'))
    fs['.gradle/8.4'] = ls(f('lock'))
    act(() => useProject.setState({ changes: [{ path: 'README.md', status: 'M' }] }))
    expect(await screen.findByText('.gradle/8.4')).toBeInTheDocument()
    expect(await screen.findByText('lock')).toBeInTheDocument()
  })

  it('цвета статусов и dirm у папок с изменениями внутри; удалённый — в своей папке, зачёркнут', async () => {
    const P = 'app/src/main/java/com/shop/payments'
    fs[P] = ls(f('PaymentApi.kt'), f('RetryPolicy.kt'), f('Zeta.kt'))
    await mount([
      { path: 'README.md', status: 'M' },
      { path: `${P}/PaymentApi.kt`, status: 'M' },
      { path: `${P}/RetryPolicy.kt`, status: '?' },
      { path: `${P}/Added.kt`, status: 'A' },
      { path: `${P}/LegacyPay.kt`, status: 'D' },
    ])
    fs[P].entries.splice(0, 0, f('Added.kt'))
    expect(row('README.md')).toHaveClass('mod')
    expect(rows()[0]).toHaveClass('dirm')
    expect(row('app')).toHaveClass('dirm')
    expect(row('.gradle')).not.toHaveClass('dirm')
    fireEvent.click(row('app'))
    fireEvent.click(await screen.findByText('src'))
    expect(await screen.findByText('src/main/java')).toBeInTheDocument()
    expect(row('src')).toBeUndefined()
    expect(row('src/main/java')).toHaveClass('dirm')
    expect(await screen.findByText('com.shop')).toHaveClass('lbl')
    expect(row('com.shop')).toHaveClass('dirm')
    fireEvent.click(row('payments'))
    await screen.findByText('PaymentApi.kt')
    const names = rows().map(name)
    const i = names.indexOf('payments')
    expect(names.slice(i + 1, i + 6)).toEqual([
      'Added.kt',
      'LegacyPay.kt',
      'PaymentApi.kt',
      'RetryPolicy.kt',
      'Zeta.kt',
    ])
    expect(row('Added.kt')).toHaveClass('add')
    expect(row('LegacyPay.kt')).toHaveClass('del')
    expect(row('PaymentApi.kt')).toHaveClass('mod')
    expect(row('RetryPolicy.kt')).toHaveClass('new')
    expect(row('Zeta.kt').className).toBe('n')
  })

  it('удалённая целиком папка появляется в дереве и раскрывается', async () => {
    await mount([{ path: 'old/Gone.kt', status: 'D' }])
    expect(row('old')).toHaveClass('del')
    fireEvent.click(row('old'))
    await screen.findByText('Gone.kt')
    expect(row('Gone.kt')).toHaveClass('del')
  })

  it('не git — дерево без цветов', async () => {
    act(() => useProject.setState({ notGit: true }))
    await mount([])
    expect(rows().some((r) => /mod|add|new|del|dirm/.test(r.className))).toBe(false)
  })

  it('«ещё N» в конце большой папки', async () => {
    fs[''] = { entries: [f('a.txt')], more: 48000 }
    act(() => useProject.setState({ changes: [] }))
    render(<ProjectTree />)
    expect(await screen.findByText('ещё 48000')).toBeInTheDocument()
  })

  it('клавиши: ↑↓ выбор, → раскрыть/вглубь, ← свернуть/к родителю, ↵ открыть файл', async () => {
    await mount()
    tree().focus()
    key('ArrowDown')
    expect(sel()).toBe('shop-app')
    key('ArrowDown')
    expect(sel()).toBe('.gradle')
    key('ArrowDown')
    expect(sel()).toBe('app')
    key('ArrowRight')
    await screen.findByText('AndroidManifest.xml')
    key('ArrowRight')
    expect(sel()).toBe('src')
    key('ArrowLeft')
    expect(sel()).toBe('app')
    key('ArrowLeft')
    expect(screen.queryByText('AndroidManifest.xml')).toBeNull()
    key('ArrowDown')
    expect(sel()).toBe('README.md')
    key('Enter')
    expect(openFile).toHaveBeenCalledWith('README.md')
    key('ArrowUp')
    expect(sel()).toBe('app')
  })

  it('набор букв — к первому совпадению по имени', async () => {
    await mount()
    tree().focus()
    key('s')
    key('e')
    expect(sel()).toBe('settings.gradle.kts')
    key('ArrowUp')
    key('r')
    expect(sel()).toBe('README.md')
  })

  it('клик по файлу — выбор и открыть', async () => {
    await mount()
    fireEvent.click(row('README.md'))
    expect(sel()).toBe('README.md')
    expect(openFile).toHaveBeenCalledWith('README.md')
  })

  it('новый список изменений — раскрытые папки перечитываются', async () => {
    await mount()
    fs[''] = ls(d('.gradle'), d('app'), f('NEW.md'), f('README.md'), f('settings.gradle.kts'))
    act(() => useProject.setState({ changes: [{ path: 'NEW.md', status: '?' }] }))
    await waitFor(() => expect(row('NEW.md')).toHaveClass('new'))
  })

  it('перечитывание — одним обновлением на все раскрытые папки; те же пути и статусы — без запросов', async () => {
    await mount([{ path: 'README.md', status: 'M' }])
    fireEvent.click(row('app'))
    await screen.findByText('AndroidManifest.xml')
    list.mockClear()
    // тот же набор (новая ссылка) — не перечитываем
    act(() => useProject.setState({ changes: [{ path: 'README.md', status: 'M' }] }))
    await act(async () => {})
    expect(list).not.toHaveBeenCalled()
    // другой набор: корень ответил сразу, app — позже; новое видно только когда готовы все
    let releaseApp!: () => void
    const gate = new Promise<void>((r) => (releaseApp = r))
    list.mockImplementation(async (_root: string, rel: string) => {
      if (rel === 'app') await gate
      return fs[rel]
    })
    fs[''] = ls(d('.gradle'), d('app'), f('NEW.md'), f('README.md'), f('settings.gradle.kts'))
    fs.app = ls(d('src'), f('AndroidManifest.xml'), f('build.gradle.kts'), f('Z.kt'))
    act(() =>
      useProject.setState({
        changes: [
          { path: 'README.md', status: 'M' },
          { path: 'NEW.md', status: '?' },
        ],
      }),
    )
    await act(async () => {})
    expect(list.mock.calls.map((c) => c[1]).sort()).toEqual(['', 'app'])
    expect(row('NEW.md')).toBeUndefined()
    await act(async () => releaseApp())
    await waitFor(() => expect(row('NEW.md')).toBeDefined())
    expect(row('Z.kt')).toBeDefined()
    list.mockImplementation(async (_root: string, rel: string) => {
      const x = fs[rel]
      if (!x) throw new Error('нет каталога')
      return x
    })
  })

  it('свернули папку с выбранной строкой внутри — выбор переходит на папку', async () => {
    await mount()
    fireEvent.click(row('app'))
    fireEvent.click(await screen.findByText('AndroidManifest.xml'))
    expect(sel()).toBe('AndroidManifest.xml')
    tree().focus()
    key('ArrowUp')
    key('ArrowUp')
    expect(sel()).toBe('app')
    key('ArrowDown')
    fireEvent.click(row('app'))
    expect(sel()).toBe('app')
    fireEvent.click(row('app'))
    fireEvent.click(await screen.findByText('build.gradle.kts'))
    fireEvent.click(rows()[0])
    expect(sel()).toBe('shop-app')
  })

  it('фокус с окна переходит в дерево при открытии', async () => {
    const tw = document.createElement('div')
    tw.className = 'tw'
    tw.tabIndex = -1
    document.body.appendChild(tw)
    tw.focus()
    act(() => useProject.setState({ changes: [] }))
    render(<ProjectTree />, { container: tw })
    await screen.findByText('README.md')
    expect(document.activeElement).toBe(tree())
    tw.remove()
  })
})
