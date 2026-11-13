import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { openUrl } from '@tauri-apps/plugin-opener'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent, FeedClaudeItem } from '../reducer'
import { Markdown } from '../Markdown'
import { ActionCard, diffLines } from './ActionCard'
import { AssistantCard } from './AssistantCard'
import { ClaudeCard } from './ClaudeCard'
import { ErrorCard } from './ErrorCard'
import { SummaryCard } from './SummaryCard'
import { UserBubble } from './UserBubble'

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn(() => Promise.resolve()) }))

const agent = (o: Partial<Agent> = {}): Agent => ({
  id: 'main',
  parentId: null,
  name: 'Главный',
  model: 'claude-opus-5-5',
  status: 'running',
  now: '',
  history: [],
  step: null,
  startedAt: 0,
  endedAt: null,
  tokens: 0,
  ...o,
})

type Action = Extract<FeedClaudeItem, { type: 'action' }>
const action = (o: Partial<Action> = {}): Action => ({
  type: 'action',
  agentId: 'main',
  toolUseId: 't1',
  tool: 'Bash',
  title: 'Запустил команду',
  detail: 'npm test',
  status: 'done',
  ...o,
})

afterEach(() => vi.clearAllMocks())

describe('Markdown', () => {
  it('рисует таблицу GFM', () => {
    const { container } = render(<Markdown text={'| Файл | Строк |\n|---|---|\n| a.ts | 10 |\n| b.ts | 20 |'} />)
    const table = container.querySelector('table')
    expect(table).not.toBeNull()
    expect(table!.querySelectorAll('th')).toHaveLength(2)
    expect(table!.querySelectorAll('tbody tr')).toHaveLength(2)
    expect(screen.getByText('b.ts')).toBeInTheDocument()
  })

  it('рисует блок кода с подсветкой и кнопкой «Копировать»', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const { container } = render(<Markdown text={'```ts\nconst x = 1 // один\n```'} />)
    const code = container.querySelector('pre code')
    expect(code).not.toBeNull()
    expect(code!.textContent).toBe('const x = 1 // один\n')
    expect(container.querySelector('pre .hljs-keyword')?.textContent).toBe('const')
    const btn = screen.getByRole('button', { name: 'Копировать код' })
    expect(btn).toHaveTextContent('Копировать')
    fireEvent.click(btn)
    expect(writeText).toHaveBeenCalledWith('const x = 1 // один')
    await waitFor(() => expect(btn).toHaveTextContent('Скопировано'))
  })

  it('HTML в тексте не исполняется: <script> выводится как текст', () => {
    const { container } = render(<Markdown text={'Вот: <script>window.__x = 1</script> и <b>жирный</b>'} />)
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('b')).toBeNull()
    expect(container.textContent).toContain('<script>window.__x = 1</script>')
    expect((window as unknown as { __x?: number }).__x).toBeUndefined()
  })

  it('заголовки, списки и inline-код', () => {
    const { container } = render(<Markdown text={'## План\n\n1. Первый\n2. Второй\n\n- пункт с `code`'} />)
    expect(container.querySelector('h2')?.textContent).toBe('План')
    expect(container.querySelectorAll('ol li')).toHaveLength(2)
    expect(container.querySelector('ul li code')?.textContent).toBe('code')
  })

  it('ссылка открывается через opener, а не в окне приложения', () => {
    render(<Markdown text={'См. [доки](https://example.com/docs)'} />)
    const a = screen.getByRole('link', { name: 'доки' })
    const ev = fireEvent.click(a)
    expect(ev).toBe(false) // preventDefault
    expect(openUrl).toHaveBeenCalledWith('https://example.com/docs')
  })

  it('⌘-клик открывает через opener, средний клик не уводит webview', () => {
    render(<Markdown text={'[доки](https://example.com/docs)'} />)
    const a = screen.getByRole('link', { name: 'доки' })
    expect(fireEvent.click(a, { metaKey: true })).toBe(false)
    expect(openUrl).toHaveBeenCalledWith('https://example.com/docs')
    expect(fireEvent(a, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }))).toBe(false)
    expect(openUrl).toHaveBeenCalledTimes(1)
  })

  it('картинка не загружается — вместо неё ссылка с подписью', () => {
    const { container } = render(<Markdown text={'![схема](https://evil.example/x.png?d=secret)'} />)
    expect(container.querySelector('img')).toBeNull()
    const a = screen.getByRole('link', { name: /схема/ })
    expect(fireEvent.click(a)).toBe(false)
    expect(openUrl).toHaveBeenCalledWith('https://evil.example/x.png?d=secret')
  })

  it('ссылки javascript: не открываются', () => {
    render(<Markdown text={'[x](javascript:alert(1))'} />)
    const a = screen.getByText('x')
    fireEvent.click(a)
    expect(openUrl).not.toHaveBeenCalled()
  })

  it('стриминг — курсор в конце текста', () => {
    const { container } = render(<Markdown text={'Пишу ответ'} streaming />)
    const caret = container.querySelector('.caret')
    expect(caret).not.toBeNull()
    expect(caret!.closest('p')?.textContent).toBe('Пишу ответ')
  })
})

describe('карточки', () => {
  it('вопрос пользователя: подпись «Вы» и текст', () => {
    const { container } = render(<UserBubble text="Сделай модуль оплаты" />)
    expect(container.querySelector('.you .who')?.textContent).toBe('Вы')
    expect(screen.getByText('Сделай модуль оплаты')).toBeInTheDocument()
  })

  it('ответ: подпись «Имя агента · Модель»', () => {
    const { container } = render(<AssistantCard agent={agent()} text="Готово" streaming={false} />)
    expect(container.querySelector('.card .who')?.textContent).toBe('Главный · Opus 5.5')
    expect(container.querySelector('.card')).not.toHaveClass('fable')
    expect(container.querySelector('.caret')).toBeNull()
  })

  it('ответ Fable — золотая подпись и полоса', () => {
    const { container } = render(
      <AssistantCard agent={agent({ name: 'Архитектор', model: 'claude-fable-5-2' })} text="Три слоя" streaming />,
    )
    expect(container.querySelector('.card .who')?.textContent).toBe('Архитектор · Fable 5.2')
    expect(container.querySelector('.card')).toHaveClass('fable')
    expect(container.querySelector('.caret')).not.toBeNull()
  })

  it('ответ без модели и без агента — только имя', () => {
    const { container } = render(<AssistantCard agent={agent({ model: null })} text="x" streaming={false} />)
    expect(container.querySelector('.who')?.textContent).toBe('Главный')
    const { container: c2 } = render(<AssistantCard agent={undefined} text="x" streaming={false} />)
    expect(c2.querySelector('.who')?.textContent).toBe('Claude')
  })

  it('действие: подпись, деталь и краткий результат', () => {
    const { container } = render(<ActionCard item={action({ result: '3 passed, 1 failed\nмного строк' })} agent={agent()} />)
    expect(container.querySelector('.act .who')?.textContent).toBe('▶ Запустил команду')
    expect(container.querySelector('.act b')?.textContent).toBe('npm test')
    expect(container.querySelector('.act')?.textContent).toContain('3 passed, 1 failed')
    expect(container.querySelector('.act')?.textContent).not.toContain('много строк')
  })

  it('действие субагента: подпись «Имя · Модель», в теле — название и деталь', () => {
    const item = action({ agentId: 'tu1', tool: 'Grep', title: 'Искал', detail: 'onSubmit', result: 'Form.tsx:42' })
    const { container } = render(
      <ActionCard item={item} agent={agent({ id: 'tu1', name: 'Поиск', model: 'claude-haiku-5-5' })} />,
    )
    const act = container.querySelector('.act')!
    expect(act.querySelector('.who')?.textContent).toBe('▶ Поиск · Haiku 5.5')
    expect(act.querySelector('b')?.textContent).toBe('onSubmit')
    expect(act.textContent).toBe('▶ Поиск · Haiku 5.5Искал onSubmit — Form.tsx:42')
  })

  it('действие субагента без модели — только имя; правка файла — ✎', () => {
    const item = action({ agentId: 'tu1', tool: 'Edit', title: 'Изменил файл', detail: 'a.ts' })
    const { container } = render(<ActionCard item={item} agent={agent({ id: 'tu1', name: 'Стили', model: null })} />)
    expect(container.querySelector('.act .who')?.textContent).toBe('✎ Стили')
  })

  it('идущее действие — .run и «Сейчас выполняю…»', () => {
    const { container } = render(<ActionCard item={action({ status: 'running' })} agent={agent()} />)
    expect(container.querySelector('.act')).toHaveClass('run')
    expect(screen.getByText('Сейчас выполняю…')).toBeInTheDocument()
  })

  it('изменение файла: ✎ и diff со строками -/+', () => {
    const item = action({
      tool: 'Edit',
      title: 'Изменил файл',
      detail: 'src/Form.tsx',
      diff: { path: 'src/Form.tsx', before: '<button>', after: '<button onClick={send}>' },
    })
    const { container } = render(<ActionCard item={item} agent={agent()} />)
    expect(container.querySelector('.act .who')?.textContent).toBe('✎ Изменил файл')
    const lines = Array.from(container.querySelectorAll('.diff > div'), (d) => [d.className, d.textContent])
    expect(lines).toEqual([
      ['d', '- <button>'],
      ['a', '+ <button onClick={send}>'],
    ])
  })

  it('diffLines: общие строки по краям — контекст, середина — -/+', () => {
    expect(diffLines('a\nb\nc', 'a\nB\nc')).toEqual([
      { k: 'n', t: 'a' },
      { k: 'd', t: 'b' },
      { k: 'a', t: 'B' },
      { k: 'n', t: 'c' },
    ])
    expect(diffLines('', 'new')).toEqual([{ k: 'a', t: 'new' }])
  })

  it('итог: «✓ Итог», время и стоимость', () => {
    const { container } = render(<SummaryCard text="Все **4** теста проходят" durationMs={12300} costUsd={0.0421} isError={false} />)
    expect(container.querySelector('.sum .who')?.textContent).toBe('✓ Итог12.3 с · $0.04')
    expect(container.querySelector('.sum strong')?.textContent).toBe('4')
  })

  it('итог без текста (ответ уже выше) — одна строка «✓ Готово»', () => {
    const { container } = render(<SummaryCard text="" durationMs={52600} costUsd={0.29} isError={false} />)
    expect(container.querySelector('.sum .who')?.textContent).toBe('✓ Готово52.6 с · $0.29')
    expect(container.querySelector('.sum .md, .sum p')).toBeNull()
  })

  it('итог с ошибкой помечен', () => {
    const { container } = render(<SummaryCard text="упало" durationMs={1000} costUsd={0} isError />)
    expect(container.querySelector('.sum')).toHaveClass('err')
  })

  it('ошибка — карточка .cerr с текстом', () => {
    const { container } = render(<ErrorCard text="claude не найден в PATH" />)
    expect(container.querySelector('.cerr')?.textContent).toContain('claude не найден в PATH')
  })

  it('ClaudeCard выбирает карточку и подписывает её переданным агентом', () => {
    const agents = [agent(), agent({ id: 'tu1', name: 'Архитектор', model: 'claude-fable-5-2' })]
    const { container } = render(
      <ClaudeCard item={{ kind: 'claude', id: 'c1', item: { type: 'assistant', agentId: 'tu1', text: 'x', streaming: false } }} agent={agents[1]} />,
    )
    expect(container.querySelector('[data-item-id="c1"]')).toHaveClass('card')
    expect(container.querySelector('.who')?.textContent).toBe('Архитектор · Fable 5.2')
  })
})

describe('SessionNote', () => {
  it('строка сессии; при входе командой `claude` — с подсказкой', async () => {
    const { SessionNote, MODE_HINT } = await import('./SessionNote')
    const { container, rerender } = render(<SessionNote cwd="/w/proj" />)
    expect(container.textContent).toBe('Claude · /w/proj')
    rerender(<SessionNote cwd="/w/proj" mode />)
    expect(container.textContent).toBe('Claude · /w/proj — пишите вопрос, /exit — выйти')
    expect(MODE_HINT).toBe(' — пишите вопрос, /exit — выйти')
  })
})

describe('заметка ленты', () => {
  it('note — моноширинная строка .cl-note', () => {
    const { container } = render(
      <ClaudeCard item={{ kind: 'claude', id: 'n1', item: { type: 'note', text: 'Модель: Fable 5.2 · усилие high' } }} />,
    )
    const el = container.querySelector('[data-item-id="n1"]')!
    expect(el).toHaveClass('cl-note')
    expect(el.textContent).toBe('Модель: Fable 5.2 · усилие high')
  })
})
