import { fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { COLLAPSE_LINES, type FeedItem, type ShellBlock } from './feed'
import { Feed } from './FeedView'
import { LiveTerminal } from './LiveTerminal'
import { ShellBlockView } from './ShellBlockView'

const blk = (o: Partial<ShellBlock> = {}): ShellBlock => ({
  kind: 'shell',
  id: 'b1',
  command: 'git status',
  cwd: '/w',
  startedAt: 0,
  durationMs: 100,
  exitCode: 0,
  html: '<div><span>On branch main</span></div>',
  lines: 1,
  running: false,
  ...o,
})
const rows = (n: number) => Array.from({ length: n }, (_, i) => `<div><span>row${i}</span></div>`).join('')

describe('Feed', () => {
  it('рисует блоки и Claude-элементы по порядку', () => {
    const items: FeedItem[] = [
      blk({ id: 'a', command: 'ls' }),
      { kind: 'claude', id: 'c1', item: { type: 'user', text: 'Привет' } },
      blk({ id: 'b', command: 'pwd' }),
    ]
    const { container } = render(<Feed items={items} selectedId={null} renderLive={() => null} />)
    const seq = Array.from(container.querySelectorAll('[data-block-id], [data-item-id]'), (el) =>
      el.getAttribute('data-block-id') ?? el.getAttribute('data-item-id'),
    )
    expect(seq).toEqual(['a', 'c1', 'b'])
    expect(screen.getByText('Привет')).toBeInTheDocument()
  })

  it('карточку подписывает агент по agentId', () => {
    const ag = (id: string, name: string) => ({ id, parentId: null, name, model: 'claude-opus-5-5', status: 'running' as const, now: '', history: [], step: null, startedAt: 0, endedAt: null, tokens: 0 })
    const a1 = ag('main', 'Главный')
    const items: FeedItem[] = [{ kind: 'claude', id: 'c1', item: { type: 'assistant', agentId: 'main', text: 'x', streaming: false } }]
    const { container, rerender } = render(<Feed items={items} agents={[a1, ag('t', 'Поиск')]} selectedId={null} renderLive={() => null} />)
    const who = container.querySelector('.who')!
    expect(who.textContent).toBe('Главный · Opus 5.5')
    rerender(<Feed items={items} agents={[a1, ag('t', 'Поиск 2')]} selectedId={null} renderLive={() => null} />)
    expect(container.querySelector('.who')).toBe(who)
  })

  it('renderClaude подменяет вид Claude-элемента (шов для Task 6)', () => {
    const items: FeedItem[] = [{ kind: 'claude', id: 'c1', item: { type: 'error', text: 'нет claude' } }]
    render(<Feed items={items} selectedId={null} renderLive={() => null} renderClaude={(it) => <i>card {it.id}</i>} />)
    expect(screen.getByText('card c1')).toBeInTheDocument()
  })

  it('running-блок содержит живой терминал, завершённые — нет', () => {
    const renderLive = vi.fn(() => <div data-testid="live" />)
    const items: FeedItem[] = [blk({ id: 'a' }), blk({ id: 'r', running: true, durationMs: null, exitCode: null, html: null })]
    const { container } = render(<Feed items={items} selectedId={null} renderLive={renderLive} />)
    expect(renderLive).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-block-id="r"] [data-testid="live"]')).not.toBeNull()
    expect(container.querySelector('[data-block-id="a"] [data-testid="live"]')).toBeNull()
  })

  it('выбранный блок — .sel; ref на прокручиваемую ленту', () => {
    const ref = createRef<HTMLDivElement>()
    render(<Feed ref={ref} items={[blk()]} selectedId="b1" renderLive={() => null} />)
    expect(ref.current).toHaveClass('feed')
    expect(ref.current!.querySelector('.blk')).toHaveClass('sel')
  })
})

describe('ShellBlockView', () => {
  it('заголовок ❯ команда и длительность', () => {
    const { container } = render(<ShellBlockView block={blk()} selected={false} />)
    expect(container.querySelector('.bh .p')!.textContent).toBe('❯')
    expect(container.querySelector('.bh .cmd')!.textContent).toBe('git status')
    expect(container.querySelector('.bh')!.textContent).toContain('0.1 с')
    expect(container.querySelector('.out')!.textContent).toBe('On branch main')
    expect(container.querySelector('.blk')).not.toHaveClass('err')
  })

  it('ненулевой код — .err и exit N справа', () => {
    const { container } = render(<ShellBlockView block={blk({ exitCode: 127 })} selected={false} />)
    expect(container.querySelector('.blk')).toHaveClass('err')
    expect(container.querySelector('.exit')!.textContent).toBe('exit 127')
  })

  it(`блок длиннее ${COLLAPSE_LINES} строк свёрнут до 200 и раскрывается кнопкой`, () => {
    const n = COLLAPSE_LINES + 5
    const { container } = render(<ShellBlockView block={blk({ html: rows(n), lines: n })} selected={false} />)
    expect(container.querySelectorAll('.out > div')).toHaveLength(200)
    fireEvent.click(screen.getByRole('button', { name: `Показать всё (${n} строк)` }))
    expect(container.querySelectorAll('.out > div')).toHaveLength(n)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('действия в заголовке: «Повторить» есть, если передан; «Спросить Claude» — только при коде ≠ 0; у идущего — ничего', () => {
    const onRepeat = vi.fn()
    const onAsk = vi.fn()
    const ok = render(<ShellBlockView block={blk()} selected={false} onRepeat={onRepeat} onAsk={onAsk} />)
    expect(ok.container.querySelector('.bh .bh-act')!.textContent).toBe('Повторить')
    ok.unmount()
    const bad = render(<ShellBlockView block={blk({ exitCode: 1 })} selected={false} onAsk={onAsk} />)
    fireEvent.click(screen.getByRole('button', { name: 'Спросить Claude' }))
    expect(onAsk).toHaveBeenCalledWith('b1')
    expect(screen.queryByRole('button', { name: 'Повторить' })).toBeNull()
    bad.unmount()
    const run = render(<ShellBlockView block={blk({ running: true, exitCode: null })} selected={false} onRepeat={onRepeat} onAsk={onAsk} />)
    expect(run.container.querySelector('.bh-act')).toBeNull()
  })

  it(`ровно ${COLLAPSE_LINES} строк — не свёрнут`, () => {
    const { container } = render(
      <ShellBlockView block={blk({ html: rows(COLLAPSE_LINES), lines: COLLAPSE_LINES })} selected={false} />,
    )
    expect(container.querySelectorAll('.out > div')).toHaveLength(COLLAPSE_LINES)
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('LiveTerminal', () => {
  it('переносит host в слот и возвращает в парковку при размонтировании', () => {
    const park = document.createElement('div')
    document.body.appendChild(park)
    const host = document.createElement('div')
    park.appendChild(host)
    const onAttach = vi.fn()
    const parkRef = { current: park }
    const { unmount, getByTestId } = render(
      <LiveTerminal host={host} parkRef={parkRef} mode="block" hostHeight={300} height={40} onAttach={onAttach} />,
    )
    expect(getByTestId('live-block').contains(host)).toBe(true)
    expect(getByTestId('live-block').style.height).toBe('40px')
    expect(host.style.height).toBe('300px')
    expect(onAttach).toHaveBeenCalledTimes(1)
    unmount()
    expect(host.parentElement).toBe(park)
    park.remove()
  })

  it('смена высоты не переносит host заново; при размонтировании onDetach сообщает о фокусе', () => {
    const park = document.createElement('div')
    document.body.appendChild(park)
    const host = document.createElement('div')
    const input = document.createElement('textarea')
    host.appendChild(input)
    const onAttach = vi.fn()
    const onDetach = vi.fn()
    const parkRef = { current: park }
    const el = (h: number) => (
      <LiveTerminal host={host} parkRef={parkRef} mode="block" hostHeight={h} height={40} onAttach={onAttach} onDetach={onDetach} />
    )
    const { rerender, unmount } = render(el(300))
    rerender(el(400))
    expect(onAttach).toHaveBeenCalledTimes(1)
    expect(host.style.height).toBe('400px')
    input.focus()
    unmount()
    expect(host.parentElement).toBe(park)
    expect(onDetach).toHaveBeenCalledWith(true)
    park.remove()
  })

  it('overlay — host на всю высоту', () => {
    const host = document.createElement('div')
    const { getByTestId } = render(
      <LiveTerminal host={host} parkRef={{ current: null }} mode="overlay" hostHeight={300} height={0} onAttach={() => {}} />,
    )
    expect(getByTestId('live-overlay').contains(host)).toBe(true)
    expect(host.style.height).toBe('100%')
  })
})
