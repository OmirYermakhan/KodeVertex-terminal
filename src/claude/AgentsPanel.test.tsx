import { createRef } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { initialClaude } from './reducer'
import { agent, mockupScene, T0 } from './fixtures/mockupScene'
import { AgentsPanel, agentElapsed, agentRows, pastLabel, tokensLabel, type AgentsPanelHandle } from './AgentsPanel'

const rowsText = () => Array.from(document.querySelectorAll('.row')).map((r) => Array.from(r.children).map((c) => c.textContent))

describe('helpers', () => {
  it('время всегда «Nм NNс», токены — «51k»', () => {
    expect(agentElapsed(18_000)).toBe('0м 18с')
    expect(agentElapsed(130_400)).toBe('2м 10с')
    expect(tokensLabel(51_234)).toBe('51k')
    expect(tokensLabel(800)).toBe('800')
  })
  it('история — в прошедшем времени', () => {
    expect(pastLabel('Читает Order.kt')).toBe('прочитал Order.kt')
    expect(pastLabel('Обновляет план')).toBe('обновил план')
    expect(pastLabel('Составил план')).toBe('составил план')
  })
  it('дети — сразу под родителем', () => {
    const rows = agentRows(mockupScene().agents)
    expect(rows.map((r) => [r.agent.name, r.depth])).toEqual([['Архитектор', 0], ['Стили', 1], ['Главный', 0], ['Поиск', 1]])
  })
})

describe('AgentsPanel', () => {
  it('заголовок, строки по макету: точки, └, модель (Fable — золотая), что делает, время, токены', () => {
    render(<AgentsPanel state={mockupScene()} onExit={() => {}} now={T0} />)
    expect(document.querySelector('.dh')!.textContent).toBe(
      'Агенты · 2 работают · 1 ждёт · 1 готов↑↓ выбрать · ↵ подробно · esc назад к вводу · ⌘J скрыть',
    )
    expect(document.querySelector('.dh b')!.textContent).toBe('2 работают')
    expect(rowsText()).toEqual([
      ['', 'Архитектор', 'Fable 5.2', 'Проектирует модуль оплаты · 2 из 3', '2м 10с', '51k'],
      ['', 'Стили', 'Sonnet 5.5', 'Читает form.css · 3 из 7', '0м 41с', '12k'],
      ['', 'Главный', 'Opus 5.5', 'Ждёт вашего ответа: удалить старый API?', '3м 02с', '84k'],
      ['', 'Поиск', 'Haiku 5.5', 'Готово', '0м 18с', '6k'],
    ])
    const rows = document.querySelectorAll('.row')
    expect(Array.from(rows).map((r) => r.querySelector('.s')!.className)).toEqual(['s run', 's run', 's wait', 's done'])
    expect(Array.from(rows).map((r) => r.classList.contains('sub'))).toEqual([false, true, false, true])
    expect(rows[0].querySelector('.m')).toHaveClass('f')
    expect(rows[1].querySelector('.m')).not.toHaveClass('f')
    expect(rows[0].querySelector('b')!.textContent).toBe('модуль оплаты')
    expect(rows[2].querySelector('.w')).toHaveClass('waiting')
    expect(document.querySelector('.row.focus')).toBeNull()
  })

  it('ошибка — красная точка', () => {
    const s = { ...initialClaude(), agents: [agent({ id: 'main', name: 'Главный', status: 'error', now: 'Ошибка', endedAt: T0 })] }
    render(<AgentsPanel state={s} onExit={() => {}} now={T0} />)
    expect(document.querySelector('.row .s')).toHaveClass('err')
    expect(document.querySelector('.dh')!.textContent).toContain('1 ошибка')
  })

  it('фокус: выбирается текущий агент; ↑↓ выбор; ↵ раскрывает подробности; esc — назад', () => {
    const ref = createRef<AgentsPanelHandle>()
    const onExit = vi.fn()
    render(<AgentsPanel ref={ref} state={mockupScene()} onExit={onExit} now={T0} />)
    act(() => ref.current!.focus())
    const box = screen.getByRole('listbox')
    expect(document.activeElement).toBe(box)
    const focused = () => document.querySelector('.row.focus')?.getAttribute('data-agent-id')
    expect(focused()).toBe('arch')

    fireEvent.keyDown(box, { key: 'Enter' })
    const detail = screen.getByTestId('agent-detail')
    expect(detail.previousElementSibling).toHaveAttribute('data-agent-id', 'arch')
    expect(detail.textContent).toBe(
      '→ сейчас: проектирует модуль оплаты✓ прочитал PaymentApi.kt✓ записал PaymentService.kt · шаг 2 из 3',
    )
    expect(detail.querySelector('.now')!.textContent).toBe('→ сейчас:')
    // У раскрытой строки шаг — в подробностях, а не в строке.
    expect(rowsText()[0][3]).toBe('Проектирует модуль оплаты')
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(screen.queryByTestId('agent-detail')).toBeNull()

    fireEvent.keyDown(box, { key: 'ArrowDown' })
    fireEvent.keyDown(box, { key: 'ArrowDown' })
    expect(focused()).toBe('main')
    fireEvent.keyDown(box, { key: 'ArrowDown' })
    fireEvent.keyDown(box, { key: 'ArrowDown' })
    expect(focused()).toBe('find')
    fireEvent.keyDown(box, { key: 'ArrowUp' })
    expect(focused()).toBe('main')

    fireEvent.keyDown(box, { key: 'Escape' })
    expect(onExit).toHaveBeenCalledTimes(1)
  })

  it('клик по строке выбирает её, второй клик раскрывает', () => {
    render(<AgentsPanel state={mockupScene()} onExit={() => {}} now={T0} />)
    const row = document.querySelector('[data-agent-id="find"]')!
    fireEvent.click(row)
    expect(row).toHaveClass('focus')
    fireEvent.click(row)
    expect(screen.getByTestId('agent-detail').textContent).toBe('Готово')
  })

  it('время работающих агентов тикает', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(T0)
      render(<AgentsPanel state={mockupScene()} onExit={() => {}} />)
      expect(rowsText()[1][4]).toBe('0м 41с')
      act(() => vi.advanceTimersByTime(2000))
      expect(rowsText()[1][4]).toBe('0м 43с')
      // Закончивший агент не тикает.
      expect(rowsText()[3][4]).toBe('0м 18с')
    } finally {
      vi.useRealTimers()
    }
  })
})
