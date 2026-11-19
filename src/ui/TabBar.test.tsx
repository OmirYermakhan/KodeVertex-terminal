import { fireEvent, render, screen } from '@testing-library/react'
import { act, Profiler } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useClaudeSessions } from '../claude/sessionStore'
import { initialClaude, type ClaudeState } from '../claude/reducer'
import { mockupScene } from '../claude/fixtures/mockupScene'
import { initialTabsState, useTabs } from '../layout/tabsStore'
import TabBar from './TabBar'
import * as transfer from '../windows/transfer'
import { DEFAULTS } from '../settings/settings'
import { useSettings } from '../settings/store'

vi.mock('../windows/transfer', () => ({
  canMoveToNewWindow: vi.fn(async () => true),
  moveTabToNewWindow: vi.fn(async () => true),
  moveTabToWindow: vi.fn(async () => true),
  windowAt: vi.fn(async () => null),
  isTransferring: vi.fn(() => false),
}))

describe('TabBar', () => {
  beforeEach(() => {
    useTabs.setState(initialTabsState())
    useClaudeSessions.setState({ sessions: {} })
  })

  const setSession = (paneId: string, state: ClaudeState) =>
    act(() =>
      useClaudeSessions.setState((s) => ({ sessions: { ...s.sessions, [paneId]: { state, procId: 'c', cwd: null, model: null, effort: null, permissionMode: null, queue: [], paused: false, pauseHint: false } } })),
    )
  const dots = () => screen.getAllByRole('tab').map((t) => t.querySelector('[data-testid="tab-dot"]')?.getAttribute('data-status') ?? null)
  const doneState = (endedAt: number): ClaudeState => {
    const s = initialClaude()
    return { ...s, agents: s.agents.map((a) => ({ ...a, status: 'done', startedAt: endedAt - 1000, endedAt })) }
  }

  it('точки: активная — --acc; работает — пульс, ждёт, ошибка; «готово» — пока вкладку не открыли', () => {
    act(() => useTabs.getState().newTab())
    const [a, b] = useTabs.getState().tabs
    render(<TabBar />)
    // Активна вторая вкладка; у первой без Claude точки нет.
    expect(dots()).toEqual([null, 'on'])

    setSession(a.focused, mockupScene()) // Главный ждёт ответа
    expect(dots()).toEqual(['waiting', 'on'])
    setSession(a.focused, { ...mockupScene(), agents: mockupScene().agents.filter((x) => x.status !== 'waiting') })
    expect(dots()).toEqual(['running', 'on'])
    expect(screen.getAllByRole('tab')[0].textContent).toContain('· claude')

    setSession(a.focused, doneState(Date.now()))
    expect(dots()).toEqual(['done', 'on'])
    // Открыли вкладку — «готово» увидено.
    act(() => useTabs.getState().activate(a.id))
    expect(dots()).toEqual(['on', null])
    act(() => useTabs.getState().activate(b.id))
    expect(dots()).toEqual([null, 'on'])

    const err = initialClaude()
    setSession(a.focused, { ...err, agents: err.agents.map((x) => ({ ...x, status: 'error', startedAt: 1, endedAt: 2 })) })
    expect(dots()).toEqual(['error', 'on'])
  })

  it('готово в активной вкладке — уже увидено', () => {
    const [a] = useTabs.getState().tabs
    render(<TabBar />)
    setSession(a.focused, doneState(Date.now()))
    act(() => useTabs.getState().newTab())
    expect(dots()).toEqual([null, 'on'])
  })

  it('titles a tab by the last cwd segment', () => {
    const t = useTabs.getState().tabs[0]
    useTabs.getState().setCwd(t.focused, '/Users/me/projects/demo')
    render(<TabBar />)
    // Имя — и во вкладке, и в кнопке проекта слева (макет 07).
    expect(screen.getByRole('tab')).toHaveTextContent('demo')
    expect(screen.getByRole('button', { name: /demo/ })).toHaveClass('proj')
  })

  it('+ adds a tab, click selects, middle click closes', () => {
    render(<TabBar />)
    fireEvent.click(screen.getByLabelText('Новая вкладка'))
    expect(useTabs.getState().tabs).toHaveLength(2)
    const [first] = screen.getAllByRole('tab')
    fireEvent.click(first)
    expect(useTabs.getState().active).toBe(useTabs.getState().tabs[0].id)
    fireEvent(first, new MouseEvent('auxclick', { bubbles: true, button: 1 }))
    expect(useTabs.getState().tabs).toHaveLength(1)
  })

  it('токены ответа в панели (статус тот же) полосу не перерисовывают; смена статуса — перерисовывает', () => {
    const [a] = useTabs.getState().tabs
    let renders = 0
    render(
      <Profiler id="tabs" onRender={() => void renders++}>
        <TabBar />
      </Profiler>,
    )
    const busy = { ...mockupScene(), agents: mockupScene().agents.filter((x) => x.status !== 'waiting') }
    setSession(a.focused, busy)
    const before = renders
    setSession(a.focused, { ...busy, items: [...busy.items, { type: 'note', text: 'токен' }] })
    setSession(a.focused, { ...busy, items: [...busy.items, { type: 'note', text: 'ещё токен' }] })
    expect(renders).toBe(before)
    setSession(a.focused, mockupScene())
    expect(renders).toBe(before + 1)
    expect(dots()).toEqual(['waiting'])
  })

  describe('перетаскивание', () => {
    // Раскладка для jsdom: полоса 0..800 × 0..38, вкладки по 100px с шагом 104 (gap 4) от x=100.
    const realRect = HTMLElement.prototype.getBoundingClientRect
    const rect = (left: number, top: number, width: number, height: number) =>
      ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect
    beforeEach(() => {
      vi.mocked(transfer.canMoveToNewWindow).mockResolvedValue(true)
      vi.mocked(transfer.windowAt).mockResolvedValue(null)
      vi.mocked(transfer.moveTabToNewWindow).mockClear()
      vi.mocked(transfer.moveTabToWindow).mockClear()
      HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
        if (this.dataset.testid === 'tabbar') return rect(0, 0, 800, 38)
        if (this.getAttribute('role') === 'tab') {
          const i = [...document.querySelectorAll('[role="tab"]')].indexOf(this)
          return rect(100 + i * 104, 6, 100, 26)
        }
        return realRect.call(this)
      }
    })
    afterEach(() => {
      HTMLElement.prototype.getBoundingClientRect = realRect
    })

    const three = () => {
      act(() => {
        useTabs.getState().newTab()
        useTabs.getState().newTab()
      })
      return useTabs.getState().tabs.map((t) => t.id)
    }
    const ids = () => useTabs.getState().tabs.map((t) => t.id)
    const pt = (x: number, y: number, extra: Record<string, number> = {}) => ({ pointerId: 1, button: 0, clientX: x, clientY: y, screenX: x + 1000, screenY: y + 500, ...extra })
    const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    it('перестановка: вкладка идёт за курсором, соседи расступаются, порядок — при отпускании', () => {
      const [a, b, c] = three()
      render(<TabBar />)
      const tab = screen.getAllByRole('tab')[0]
      fireEvent.pointerDown(tab, pt(150, 19))
      fireEvent.pointerMove(tab, pt(300, 19))
      expect(tab).toHaveClass('dragging')
      expect(tab.style.transform).toBe('translateX(150px)')
      expect(screen.getAllByRole('tab')[1].style.transform).toBe('translateX(-104px)')
      expect(screen.getAllByRole('tab')[2].style.transform).toBe('')
      // Дальше конца полосы вкладка не уходит.
      fireEvent.pointerMove(tab, pt(600, 19))
      expect(tab.style.transform).toBe('translateX(208px)')
      // Курсор за серединой обеих соседок — обе сдвинулись влево на ширину + gap.
      expect(screen.getAllByRole('tab')[1].style.transform).toBe('translateX(-104px)')
      expect(screen.getAllByRole('tab')[2].style.transform).toBe('translateX(-104px)')
      expect(ids()).toEqual([a, b, c])
      fireEvent.pointerUp(tab, pt(600, 19))
      fireEvent.click(tab)
      expect(ids()).toEqual([b, c, a])
      // Клик после перетаскивания вкладку не активировал (активна последняя созданная).
      expect(useTabs.getState().active).toBe(c)
      expect(screen.getAllByRole('tab').every((t) => !t.style.transform && !t.classList.contains('dragging'))).toBe(true)
    })

    it('меньше 4px — не перетаскивание: клик активирует', () => {
      const [a, b, c] = three()
      render(<TabBar />)
      const tab = screen.getAllByRole('tab')[0]
      fireEvent.pointerDown(tab, pt(150, 19))
      fireEvent.pointerMove(tab, pt(153, 19))
      expect(tab).not.toHaveClass('dragging')
      fireEvent.pointerUp(tab, pt(153, 19))
      fireEvent.click(tab)
      expect(ids()).toEqual([a, b, c])
      expect(useTabs.getState().active).toBe(a)
    })

    it('нажатие на × перетаскивание не начинает', () => {
      three()
      render(<TabBar />)
      const tab = screen.getAllByRole('tab')[0]
      fireEvent.pointerDown(tab.querySelector('.tab-close')!, pt(195, 19))
      fireEvent.pointerMove(tab, pt(400, 19))
      expect(tab).not.toHaveClass('dragging')
    })

    it('вне полосы — «призрак» с названием; отпустили ниже полосы на 40px+ — новое окно в экранных координатах', async () => {
      const [a] = three()
      render(<TabBar />)
      const tab = screen.getAllByRole('tab')[0]
      fireEvent.pointerDown(tab, pt(150, 19))
      fireEvent.pointerMove(tab, pt(160, 200))
      expect(screen.getByTestId('tab-ghost')).toHaveTextContent('Терминал')
      expect(tab).toHaveClass('dragging')
      expect(tab.style.transform).toBe('')
      fireEvent.pointerUp(tab, pt(160, 200))
      await flush()
      // Внутри своего окна другое окно под ним не ищется.
      expect(transfer.windowAt).not.toHaveBeenCalled()
      expect(transfer.moveTabToNewWindow).toHaveBeenCalledWith(a, 1160, 700)
      expect(transfer.moveTabToWindow).not.toHaveBeenCalled()
      expect(screen.queryByTestId('tab-ghost')).toBeNull()
    })

    it('за пределами окна — тоже новое окно', async () => {
      const [a] = three()
      render(<TabBar />)
      const tab = screen.getAllByRole('tab')[0]
      fireEvent.pointerDown(tab, pt(150, 19))
      fireEvent.pointerUp(tab, pt(150, 19)) // без движения — клик
      fireEvent.pointerDown(tab, pt(150, 19))
      fireEvent.pointerMove(tab, pt(-50, 20))
      fireEvent.pointerUp(tab, pt(-50, 20))
      await flush()
      expect(transfer.moveTabToNewWindow).toHaveBeenCalledWith(a, 950, 520)
    })

    it('отпустили над другим окном (за пределами своего) — перенос туда', async () => {
      const [, b] = three()
      vi.mocked(transfer.windowAt).mockResolvedValue('w2')
      render(<TabBar />)
      const tab = screen.getAllByRole('tab')[1]
      fireEvent.pointerDown(tab, pt(250, 19))
      fireEvent.pointerMove(tab, pt(250, 900))
      fireEvent.pointerUp(tab, pt(250, 900))
      await flush()
      expect(transfer.windowAt).toHaveBeenCalledWith(1250, 1400)
      expect(transfer.moveTabToWindow).toHaveBeenCalledWith(b, 'w2')
      expect(transfer.moveTabToNewWindow).not.toHaveBeenCalled()
    })

    it('другое окно под своим (точка внутри своего окна) — не перенос туда', async () => {
      const [, b] = three()
      vi.mocked(transfer.windowAt).mockResolvedValue('w2')
      render(<TabBar />)
      const tab = screen.getAllByRole('tab')[1]
      fireEvent.pointerDown(tab, pt(250, 19))
      fireEvent.pointerMove(tab, pt(250, 300))
      fireEvent.pointerUp(tab, pt(250, 300))
      await flush()
      expect(transfer.windowAt).not.toHaveBeenCalled()
      expect(transfer.moveTabToWindow).not.toHaveBeenCalled()
      expect(transfer.moveTabToNewWindow).toHaveBeenCalledWith(b, 1250, 800)
    })

    it('вкладка уже переезжает — перетаскивание не начинается', async () => {
      const [a] = three()
      vi.mocked(transfer.isTransferring).mockImplementation((id) => id === a)
      try {
        render(<TabBar />)
        const tab = screen.getAllByRole('tab')[0]
        fireEvent.pointerDown(tab, pt(150, 19))
        fireEvent.pointerMove(tab, pt(150, 300))
        expect(tab).not.toHaveClass('dragging')
        fireEvent.pointerUp(tab, pt(150, 300))
        await flush()
        expect(transfer.moveTabToNewWindow).not.toHaveBeenCalled()
      } finally {
        vi.mocked(transfer.isTransferring).mockReturnValue(false)
      }
    })

    it('чуть ниже полосы (меньше 40px) — отмена', async () => {
      const [a, b, c] = three()
      render(<TabBar />)
      const tab = screen.getAllByRole('tab')[0]
      fireEvent.pointerDown(tab, pt(150, 19))
      fireEvent.pointerMove(tab, pt(150, 60))
      fireEvent.pointerUp(tab, pt(150, 60))
      await flush()
      expect(transfer.moveTabToNewWindow).not.toHaveBeenCalled()
      expect(ids()).toEqual([a, b, c])
    })

    it('единственная вкладка единственного окна — жест ничего не делает', async () => {
      vi.mocked(transfer.canMoveToNewWindow).mockResolvedValue(false)
      const [a] = ids()
      render(<TabBar />)
      const tab = screen.getByRole('tab')
      fireEvent.pointerDown(tab, pt(150, 19))
      fireEvent.pointerMove(tab, pt(150, 300))
      fireEvent.pointerUp(tab, pt(150, 300))
      await flush()
      expect(transfer.moveTabToNewWindow).not.toHaveBeenCalled()
      expect(ids()).toEqual([a])
      expect(screen.queryByTestId('tab-ghost')).toBeNull()
    })

    it('Escape и pointercancel отменяют перетаскивание', async () => {
      const [a, b, c] = three()
      render(<TabBar />)
      const tab = screen.getAllByRole('tab')[0]
      fireEvent.pointerDown(tab, pt(150, 19))
      fireEvent.pointerMove(tab, pt(300, 19))
      fireEvent.keyDown(window, { key: 'Escape' })
      expect(tab).not.toHaveClass('dragging')
      fireEvent.pointerUp(tab, pt(300, 19))
      expect(ids()).toEqual([a, b, c])

      fireEvent.pointerDown(tab, pt(150, 19))
      fireEvent.pointerMove(tab, pt(150, 300))
      fireEvent.pointerCancel(tab, pt(150, 300))
      expect(screen.queryByTestId('tab-ghost')).toBeNull()
      fireEvent.pointerUp(tab, pt(150, 300))
      await flush()
      expect(transfer.windowAt).not.toHaveBeenCalled()
      expect(ids()).toEqual([a, b, c])
    })
  })

  it('вкладка входа: своя картинка — маленькая аватарка вместо значка', () => {
    const img = 'data:image/png;base64,AAAA'
    const base = { name: 'Manaida', command: 'ssh m', icon: 'server' as const, color: '#3fb950' }
    useSettings.setState({ settings: { ...DEFAULTS, launchers: [{ id: 'L1', ...base, image: img }, { id: 'L2', ...base }] } })
    act(() => {
      useTabs.getState().newTab(undefined, 'L1')
      useTabs.getState().newTab(undefined, 'L2')
    })
    render(<TabBar />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs[1].querySelector('img.tab-img')?.getAttribute('src')).toBe(img)
    expect(tabs[1].querySelector('svg')).toBeNull()
    expect(tabs[2].querySelector('img')).toBeNull()
    expect(tabs[2].querySelector('.tab-li svg')).not.toBeNull()
    useSettings.setState({ settings: DEFAULTS })
  })
})
