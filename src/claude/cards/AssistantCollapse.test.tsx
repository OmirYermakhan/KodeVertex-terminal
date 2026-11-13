import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ANSWER_COLLAPSE_CHARS, AssistantCard, COLLAPSE, SHOW_ALL, answerCollapsible, renderedLines } from './AssistantCard'
import { scrollToRange } from '../../feed/findInFeed'

const long = 'Слово '.repeat(Math.ceil((ANSWER_COLLAPSE_CHARS + 1) / 6))

afterEach(() => vi.restoreAllMocks())

describe('сворачивание длинного ответа', () => {
  it('порог: больше 40 строк на экране или больше 4000 знаков', () => {
    expect(answerCollapsible(4000, 40)).toBe(false)
    expect(answerCollapsible(4001, 0)).toBe(true)
    expect(answerCollapsible(100, 41)).toBe(true)
    expect(answerCollapsible(100, 0)).toBe(false)
  })

  it('строки — полная высота текста / межстрочный интервал; без раскладки — 0', () => {
    const el = document.createElement('div')
    expect(renderedLines(el)).toBe(0)
    Object.defineProperty(el, 'scrollHeight', { value: 41 * 24 })
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({ lineHeight: '24px' } as CSSStyleDeclaration)
    expect(renderedLines(el)).toBe(41)
  })

  it('длинный ответ после стрима свёрнут с «Показать всё»; «Свернуть» — обратно', () => {
    const { container } = render(<AssistantCard agent={undefined} text={long} streaming={false} id="c1" />)
    expect(container.querySelector('.ans-body.clipped')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: SHOW_ALL }))
    expect(container.querySelector('.ans-body.clipped')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: COLLAPSE }))
    expect(container.querySelector('.ans-body.clipped')).not.toBeNull()
  })

  it('пока идёт стрим — не сворачивается', () => {
    const { container } = render(<AssistantCard agent={undefined} text={long} streaming id="c1" />)
    expect(container.querySelector('.ans-body.clipped')).toBeNull()
    expect(screen.queryByRole('button', { name: SHOW_ALL })).toBeNull()
  })

  it('короткий ответ — без кнопки', () => {
    render(<AssistantCard agent={undefined} text="Готово." streaming={false} id="c1" />)
    expect(screen.queryByRole('button', { name: SHOW_ALL })).toBeNull()
  })

  it('«развёрнуто» переживает ре-рендер (выбор карточки, новые сообщения)', () => {
    const { container, rerender } = render(<AssistantCard agent={undefined} text={long} streaming={false} id="c1" />)
    fireEvent.click(screen.getByRole('button', { name: SHOW_ALL }))
    rerender(<AssistantCard agent={undefined} text={long} streaming={false} id="c1" selected onRead={vi.fn()} />)
    expect(container.querySelector('.ans-body.clipped')).toBeNull()
    expect(screen.getByRole('button', { name: COLLAPSE })).toBeInTheDocument()
  })

  it('стрим закончился — тогда и сворачивается', () => {
    const { container, rerender } = render(<AssistantCard agent={undefined} text={long} streaming id="c1" />)
    rerender(<AssistantCard agent={undefined} text={long} streaming={false} id="c1" />)
    expect(container.querySelector('.ans-body.clipped')).not.toBeNull()
  })

  it('⌘F: совпадение в скрытой части разворачивает ответ', async () => {
    const { container } = render(<AssistantCard agent={undefined} text={long} streaming={false} id="c1" />)
    const body = container.querySelector('.ans-body')!
    const r = document.createRange()
    r.selectNodeContents(body.querySelector('p')!)
    scrollToRange(r, container as HTMLElement)
    expect(body.classList.contains('clipped')).toBe(false)
    expect(await screen.findByRole('button', { name: COLLAPSE })).toBeInTheDocument()
  })

  describe('замер строк при показе вкладки и смене ширины', () => {
    // 60 строк, но меньше 4000 знаков: свернуть может только замер строк.
    const lines60 = Array.from({ length: 60 }, (_, i) => `строка ${i}`).join('\n\n')
    let observers: { cb: () => void; el: Element | null; disconnected: boolean }[] = []
    const RO = globalThis.ResizeObserver
    afterEach(() => {
      globalThis.ResizeObserver = RO
      observers = []
    })
    function fakeRO() {
      globalThis.ResizeObserver = class {
        o: { cb: () => void; el: Element | null; disconnected: boolean }
        constructor(cb: () => void) {
          this.o = { cb, el: null, disconnected: false }
          observers.push(this.o)
        }
        observe(el: Element) {
          this.o.el = el
        }
        unobserve() {}
        disconnect() {
          this.o.disconnected = true
        }
      } as unknown as typeof ResizeObserver
    }
    const layout = (md: HTMLElement, width: number, height: number) => {
      Object.defineProperty(md, 'clientWidth', { value: width, configurable: true })
      Object.defineProperty(md, 'scrollHeight', { value: height, configurable: true })
    }

    it('дописан в скрытой вкладке (высота 0) — сворачивается, когда вкладку показали', () => {
      fakeRO()
      vi.spyOn(window, 'getComputedStyle').mockReturnValue({ lineHeight: '24px' } as CSSStyleDeclaration)
      const { container } = render(<AssistantCard agent={undefined} text={lines60} streaming={false} id="c1" />)
      expect(lines60.length).toBeLessThan(ANSWER_COLLAPSE_CHARS)
      expect(container.querySelector('.ans-body.clipped')).toBeNull()
      const md = container.querySelector<HTMLElement>('.md')!
      const ro = observers.find((o) => o.el === md && !o.disconnected)!
      expect(ro).toBeDefined()
      layout(md, 600, 60 * 24)
      act(() => ro.cb())
      expect(container.querySelector('.ans-body.clipped')).not.toBeNull()
      // Высота без смены ширины (свёрнутый вид) — замер не трогает.
      layout(md, 600, 10 * 24)
      act(() => ro.cb())
      expect(container.querySelector('.ans-body.clipped')).not.toBeNull()
      // Окно стало шире — строк меньше порога, ответ не свёрнут.
      layout(md, 1200, 30 * 24)
      act(() => ro.cb())
      expect(container.querySelector('.ans-body.clipped')).toBeNull()
    })

    it('во время стрима не меряет и не наблюдает', () => {
      fakeRO()
      const { container, rerender } = render(<AssistantCard agent={undefined} text={lines60} streaming id="c1" />)
      const md = container.querySelector<HTMLElement>('.md')!
      expect(observers.some((o) => o.el === md && !o.disconnected)).toBe(false)
      rerender(<AssistantCard agent={undefined} text={lines60} streaming={false} id="c1" />)
      expect(observers.some((o) => o.el === container.querySelector('.md') && !o.disconnected)).toBe(true)
    })
  })
})
