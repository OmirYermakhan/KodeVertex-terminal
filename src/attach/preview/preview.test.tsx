import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))

const { plural, sizeLabel, linesLabel, wordCount, plainMessage } = await import('./format')
const { keyAction, enterAction, editorAction, enterHint } = await import('./actions')
const { createPreview, HOVER_MS, LEAVE_MS } = await import('./usePreview')
const { PreviewCard } = await import('./PreviewCard')
const { cardWidth } = await import('./cardLayout')
const { clearPreviewCache } = await import('./api')
type Attachment = import('../types').Attachment
type PreviewData = import('./api').PreviewData
type PreviewState = import('./usePreview').PreviewState

const file = (over: Partial<Attachment> = {}): Attachment => ({ id: 'f', kind: 'file', label: 'Form.tsx', path: '/w/src/Form.tsx', ...over })
const block = (exitCode: number | null, over: Partial<Attachment> = {}): Attachment => ({
  id: 'b',
  kind: 'block',
  label: 'npm test',
  source: 'blk-1',
  block: { command: 'npm test', exitCode, cwd: '/h/shop-app', output: 'a\nb\nc\n  PASS  cart.test.ts\n  FAIL  form.test.tsx\n  ● PayButton › aligns left\n    expected "left"\n    received "right"\nTests: 1 failed, 23 passed\n', durationMs: 4200, at: new Date(2026, 10, 12, 14, 31).getTime() },
  ...over,
})
const message: Attachment = {
  id: 'm',
  kind: 'message',
  label: 'Архитектор: «Предлагаю…»',
  source: 'msg-1',
  message: { author: 'Архитектор', model: 'claude-fable-5-2', text: 'Предлагаю **три** слоя: `PaymentApi` → `PaymentService` → экран.\n\n```ts\nconst x = 1\n```\nРетраи держим в сервисе.' },
}
const key = (k: string, o: Partial<{ metaKey: boolean; shiftKey: boolean }> = {}) => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...o })

describe('подписи просмотра', () => {
  it('русские числа и размеры как в макете', () => {
    expect([1, 2, 5, 11, 21, 22, 182, 64].map(linesLabel)).toEqual(['1 строка', '2 строки', '5 строк', '11 строк', '21 строка', '22 строки', '182 строки', '64 строки'])
    expect(plural(312, 'слово', 'слова', 'слов')).toBe('312 слов')
    expect([500, 2048, 6000, 412 * 1024, 1.2 * 1024 * 1024].map(sizeLabel)).toEqual(['500 B', '2 KB', '6 KB', '412 KB', '1.2 MB'])
  })
  it('текст сообщения без разметки, `код` остаётся; слова', () => {
    expect(plainMessage(message.message!.text)).toBe('Предлагаю три слоя: `PaymentApi` → `PaymentService` → экран.\nРетраи держим в сервисе.')
    expect(wordCount('Предлагаю три слоя: `PaymentApi` → экран.')).toBe(5)
  })
})

describe('клавиши просмотра', () => {
  const text: PreviewData = { kind: 'text', start: 1, lines: ['x'], total: 1, size: 1 }
  it('↵ — главное действие типа', () => {
    expect(enterAction({ ...file(), kind: 'image', label: 'скрин' })).toEqual({ type: 'overlay', path: '/w/src/Form.tsx', label: 'скрин' })
    expect(enterAction(file({ line: 42 }))).toEqual({ type: 'open', how: 'default', path: '/w/src/Form.tsx', line: 42 })
    expect(enterAction({ ...file(), kind: 'folder' })).toEqual({ type: 'open', how: 'reveal', path: '/w/src/Form.tsx' })
    expect(enterAction({ ...file(), kind: 'pdf' })).toMatchObject({ type: 'open', how: 'default' })
    expect(enterAction(block(1))).toEqual({ type: 'jump', id: 'blk-1', kind: 'block' })
    expect(enterAction(message)).toEqual({ type: 'jump', id: 'msg-1', kind: 'message' })
    expect(enterAction(block(1, { source: undefined }))).toBeNull()
    expect(enterAction({ id: 'u', kind: 'unsupported', label: 'a.mov', reason: 'x' })).toBeNull()
  })
  it('⌘↵ — только текстовый файл; ⌫ — только в строке ввода; ←/→ — страницы PDF', () => {
    expect(editorAction(file({ line: 3 }), text)).toEqual({ type: 'open', how: 'editor', path: '/w/src/Form.tsx', line: 3 })
    expect(editorAction(file(), { kind: 'binary', size: 3 })).toBeNull()
    expect(keyAction(file(), text, 'input', key('Enter', { metaKey: true }))).toMatchObject({ how: 'editor' })
    expect(keyAction(file(), text, 'input', key('Backspace'))).toEqual({ type: 'remove', id: 'f' })
    expect(keyAction(file(), text, 'bubble', key('Backspace'))).toBeNull()
    expect(keyAction(file(), text, 'bubble', key('Escape'))).toEqual({ type: 'close' })
    const pdf: PreviewData = { kind: 'pdf', pages: 6, page: 1, size: 1, src: '' }
    const p = { ...file(), kind: 'pdf' as const }
    expect(keyAction(p, pdf, 'input', key('ArrowRight'))).toEqual({ type: 'page', delta: 1 })
    expect(keyAction(p, { ...pdf, pages: 1 }, 'input', key('ArrowRight'))).toBeNull()
    expect(keyAction(file(), text, 'input', key('a'))).toBeNull()
    expect(enterHint(p, pdf)).toBe('← → страницы · ↵ открыть')
    expect(enterHint(file(), text)).toBe('↵ открыть · ⌘↵ в редакторе')
  })

  it('исполняемое (.command, .app, .terminal…) ↵ не запускает, а показывает в Finder', () => {
    const text: PreviewData = { kind: 'text', start: 1, lines: ['x'], total: 1, size: 1 }
    for (const path of ['/d/x.command', '/d/Calc.app', '/d/x.TERMINAL', '/d/x.workflow', '/d/x.scpt', '/d/x.pkg', '/d/x.dmg', '/d/x.webloc', '/d/run.sh']) {
      expect(enterAction(file({ path }))).toEqual({ type: 'open', how: 'reveal', path })
    }
    expect(enterAction(file({ path: '/d/x.command', kind: 'pdf' }))).toMatchObject({ how: 'reveal' })
    expect(enterAction(file({ path: '/d/notes.md' }))).toMatchObject({ how: 'default' })
    expect(enterAction(file({ path: '/d/.command' }))).toMatchObject({ how: 'default' })
    expect(enterHint(file({ path: '/d/x.command' }), text)).toBe('↵ в Finder · ⌘↵ в редакторе')
    expect(enterHint(file({ path: '/d/Calc.app' }), { kind: 'binary', size: 3 })).toBe('↵ в Finder')
    // Редактор исполняемое не запускает — ⌘↵ остаётся.
    expect(editorAction(file({ path: '/d/x.command' }), text)).toMatchObject({ how: 'editor' })
  })
})

describe('мини-просмотр: открытие и закрытие', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    invoke.mockReset()
    invoke.mockResolvedValue({ kind: 'text', start: 1, lines: ['a'], total: 1, size: 1 })
    clearPreviewCache()
  })
  afterEach(() => vi.useRealTimers())
  const make = () => {
    let state: PreviewState = { target: null, data: null, page: 1, overlay: null }
    const onAction = vi.fn()
    const api = createPreview((s) => (state = s), () => ({ onAction }))
    const el = document.createElement('span')
    document.body.appendChild(el)
    return { api, onAction, el, get state() { return state } }
  }

  it('наведение — с задержкой; уход — закрывает, если мышь не перешла на карточку', () => {
    const p = make()
    p.api.hover(file(), p.el, 'bubble')
    vi.advanceTimersByTime(HOVER_MS - 10)
    // Движение внутри значка задержку не сбрасывает.
    p.api.hover(file(), p.el, 'bubble')
    expect(p.state.target).toBeNull()
    vi.advanceTimersByTime(10)
    expect(p.state.target?.token.id).toBe('f')
    expect(invoke).toHaveBeenCalledWith('preview_text', { path: '/w/src/Form.tsx', line: null })
    p.api.leave()
    p.api.enterCard()
    vi.advanceTimersByTime(LEAVE_MS * 2)
    expect(p.state.target).not.toBeNull()
    p.api.leaveCard()
    vi.advanceTimersByTime(LEAVE_MS)
    expect(p.state.target).toBeNull()
    // Ушли раньше задержки — не открывается.
    p.api.hover(file(), p.el, 'bubble')
    p.api.leave()
    vi.advanceTimersByTime(HOVER_MS * 2)
    expect(p.state.target).toBeNull()
  })

  it('␣ открывает сразу и закрывает повторно; esc закрывает; другая клавиша закрывает открытый ␣', () => {
    const p = make()
    p.api.toggle(file(), p.el, 'input')
    expect(p.state.target?.via).toBe('key')
    p.api.toggle(file(), p.el, 'input')
    expect(p.state.target).toBeNull()
    p.api.toggle(file(), p.el, 'input')
    expect(p.api.key(key('Escape'))).toBe(true)
    expect(p.state.target).toBeNull()
    p.api.toggle(file(), p.el, 'input')
    expect(p.api.key(key('x'))).toBe(false)
    expect(p.state.target).toBeNull()
  })

  it('↵ и ⌫ уходят панели; наведённый просмотр клавиш не берёт, клик — его ↵', () => {
    const p = make()
    p.api.toggle(file(), p.el, 'input')
    expect(p.api.key(key('Enter'))).toBe(true)
    expect(p.onAction).toHaveBeenLastCalledWith({ type: 'open', how: 'default', path: '/w/src/Form.tsx' }, expect.objectContaining({ id: 'f' }))
    expect(p.state.target).toBeNull()
    p.api.toggle(file(), p.el, 'input')
    expect(p.api.key(key('Backspace'))).toBe(true)
    expect(p.onAction).toHaveBeenLastCalledWith({ type: 'remove', id: 'f' }, expect.anything())
    // Наведённая карточка клавиш не берёт: ↵, ⌫, esc — тому, кто печатает; клик по ней — её ↵.
    p.api.hover(block(1), p.el, 'input')
    vi.advanceTimersByTime(HOVER_MS)
    for (const k of ['Enter', 'Backspace', 'Escape', 'a']) expect(p.api.key(key(k))).toBe(false)
    expect(p.state.target).not.toBeNull()
    // ␣ на наведённом значке открывает его с клавишами, а не закрывает.
    p.api.toggle(block(1), p.el, 'input')
    expect(p.state.target).toMatchObject({ via: 'key', keys: true })
    p.api.close()
    p.api.hover(block(1), p.el, 'bubble')
    vi.advanceTimersByTime(HOVER_MS)
    p.api.activate()
    expect(p.onAction).toHaveBeenLastCalledWith({ type: 'jump', id: 'blk-1', kind: 'block' }, expect.anything())
    p.api.hover(block(1), p.el, 'bubble')
    vi.advanceTimersByTime(HOVER_MS)
    // Строка ввода выключилась — её просмотр закрыт, пузыря — нет.
    p.api.closeFrom('input')
    expect(p.state.target).not.toBeNull()
    p.api.closeFrom('bubble')
    expect(p.state.target).toBeNull()
  })

  it('↵ на картинке — полный размер; ←/→ листают PDF', async () => {
    const p = make()
    p.api.toggle({ ...file(), kind: 'image', label: 'скрин' }, p.el, 'input')
    p.api.key(key('Enter'))
    expect(p.state.overlay).toEqual({ path: '/w/src/Form.tsx', label: 'скрин' })
    p.api.closeOverlay()
    invoke.mockImplementation((_c: string, a: { page: number }) => Promise.resolve({ pages: 3, page: a.page, size: 10, src: 'data:x' }))
    p.api.toggle({ ...file(), kind: 'pdf', label: 'spec.pdf' }, p.el, 'input')
    await act(async () => {})
    expect(p.state.data).toMatchObject({ kind: 'pdf', page: 1 })
    expect(p.api.key(key('ArrowRight'))).toBe(true)
    await act(async () => {})
    expect(invoke).toHaveBeenLastCalledWith('preview_pdf', { path: '/w/src/Form.tsx', page: 2, width: 560 })
    expect(p.state.page).toBe(2)
  })
})

describe('карточки просмотра (галерея В)', () => {
  const q = (c: HTMLElement, sel: string) => c.querySelector(sel)?.textContent
  it('код со строкой: путь от каталога сессии, окно строк с подсветкой, строки и размер', () => {
    const data: PreviewData = { kind: 'text', start: 38, lines: ['export function PayButton() {', '  const { pay } = usePayment()'], total: 182, size: 6000 }
    const { container } = render(<PreviewCard token={file({ line: 42 })} data={data} cwd="/w" />)
    expect(q(container, '.ph .pn')).toBe('src/Form.tsx')
    expect(q(container, '.ph .m')).toBe('строки 38–39')
    expect([...container.querySelectorAll('.ln')].map((e) => e.textContent)).toEqual(['38', '39'])
    expect(container.querySelector('.hljs-keyword')?.textContent).toBe('export')
    expect(q(container, '.ft')).toBe('182 строки6 KB↵ открыть · ⌘↵ в редакторе')
    expect((container.firstChild as HTMLElement).style.width).toBe('330px')
  })
  it('файл без строки — размер в заголовке; двоичный — без кода', () => {
    const { container, rerender } = render(<PreviewCard token={file({ path: '/w/src/styles/form.css', label: 'form.css' })} data={{ kind: 'text', start: 1, lines: ['.pay {'], total: 64, size: 2048 }} cwd="/w" />)
    expect(q(container, '.ph .m')).toBe('2 KB')
    expect(q(container, '.ft')).toBe('64 строки↵ открыть · ⌘↵ в редакторе')
    rerender(<PreviewCard token={file()} data={{ kind: 'binary', size: 3000 }} />)
    expect(container.querySelector('pre')).toBeNull()
    expect(q(container, '.pv-note')).toContain('Двоичный файл')
    expect(q(container, '.ft')).toBe('↵ открыть')
  })
  it('картинка: значок, размеры, вес, миниатюра из Rust; из пузыря — узкая без заголовка', () => {
    const t: Attachment = { id: 'i', kind: 'image', label: 'скрин', path: '/a/Снимок экрана 14.32.png' }
    const data: PreviewData = { kind: 'image', width: 1440, height: 900, size: 412 * 1024, src: 'data:image/png;base64,AA' }
    const { container, rerender } = render(<PreviewCard token={t} data={data} />)
    expect(container.querySelector('.ph .tk')?.textContent).toBe('скрин')
    expect(q(container, '.ph .m')).toBe('1440×900 · 412 KB')
    expect(container.querySelector('.shot img')?.getAttribute('src')).toBe('data:image/png;base64,AA')
    expect(q(container, '.ft')).toBe('Снимок экрана 14.32.png↵ целиком')
    rerender(<PreviewCard token={t} data={data} variant="bubble" />)
    expect(container.querySelector('.ph')).toBeNull()
    expect(q(container, '.ft')).toBe('скрин · 1440×900↵ целиком')
    expect(cardWidth(t, 'bubble')).toBe(210)
  })
  it('блок: команда, код и время красным у упавшего, хвост вывода, каталог и время', () => {
    const { container } = render(<PreviewCard token={block(1)} data={null} home="/h" />)
    expect(q(container, '.ph .pn')).toBe('npm test')
    expect(container.querySelector('.ph .m.bad')?.textContent).toBe('код 1 · 4.2 с')
    expect(container.querySelector('.ph .ico')?.getAttribute('class')).toBe('ico bad')
    expect(q(container, 'pre')!.split('\n')).toHaveLength(6)
    expect(q(container, 'pre')!.split('\n').at(-1)).toBe('Tests: 1 failed, 23 passed')
    expect(q(container, '.ft')).toBe('~/shop-app · 14:31↵ к блоку')
  })
  it('сообщение: автор и модель, текст без разметки, число слов', () => {
    const { container } = render(<PreviewCard token={message} data={null} />)
    expect(q(container, '.ph .pn')).toBe('Архитектор · Fable 5.2')
    expect(container.querySelector('.body.msg code')?.textContent).toBe('PaymentApi')
    expect(q(container, '.ft')).toBe('10 слов↵ к сообщению')
  })
  it('папка: первые записи со значками, «… ещё N», число файлов', () => {
    const data: PreviewData = {
      kind: 'dir',
      total: 7,
      entries: [
        { name: 'themes', isDir: true, size: null, count: 3 },
        { name: 'cart.css', isDir: false, size: 4096, count: null },
        { name: 'form.css', isDir: false, size: 2048, count: null },
        { name: 'tokens.css', isDir: false, size: 1024, count: null },
        { name: 'x.pdf', isDir: false, size: 10, count: null },
      ],
    }
    const { container } = render(<PreviewCard token={{ id: 'd', kind: 'folder', label: 'styles/', path: '/w/src/styles' }} data={data} cwd="/w" />)
    expect(q(container, '.ph .pn')).toBe('src/styles/')
    expect(q(container, '.ph .m')).toBe('7 файлов')
    const lines = q(container, 'pre')!.split('\n')
    expect(lines[0]).toBe(' themes/           3')
    expect(lines[1]).toBe(' cart.css          4 KB')
    expect(lines.at(-1)).toBe('  … ещё 2')
    expect(container.querySelectorAll('pre .ico.dir')).toHaveLength(1)
    expect(container.querySelectorAll('pre .ico.code')).toHaveLength(3)
    expect(container.querySelectorAll('pre .ico.pdf')).toHaveLength(1)
    expect(q(container, '.ft')).toBe('Claude получит путь↵ в Finder')
  })
  it('pdf: страница картинкой, «стр. 1 из 6», вес, ← → при нескольких страницах', () => {
    const t: Attachment = { id: 'p', kind: 'pdf', label: 'form-spec.pdf', path: '/w/docs/form-spec.pdf' }
    const { container } = render(<PreviewCard token={t} data={{ kind: 'pdf', pages: 6, page: 1, size: 1.2 * 1024 * 1024, src: 'data:image/jpeg;base64,BB' }} />)
    expect(q(container, '.ph .m')).toBe('стр. 1 из 6')
    expect(container.querySelector('.pdfp img')?.getAttribute('src')).toBe('data:image/jpeg;base64,BB')
    expect(q(container, '.ft')).toBe('1.2 MB← → страницы · ↵ открыть')
  })
  it('неподдерживаемое: причина; из строки ввода — «⌫ убрать»', () => {
    const t: Attachment = { id: 'u', kind: 'unsupported', label: 'demo.mov', reason: 'Видео и аудио Claude не принимает' }
    const { container } = render(<PreviewCard token={t} data={null} fromInput />)
    expect(q(container, '.pv-err')).toBe('Видео и аудио Claude не принимает')
    expect(q(container, '.ft')).toBe('Не уйдёт с сообщением⌫ убрать')
  })
  it('сбоку от выбора `@` — 220px без подвала, три строки', () => {
    const data: PreviewData = { kind: 'text', start: 29, lines: ['.pay {', '  display: flex;', '  margin-left: auto;', '  padding: 8px;'], total: 64, size: 2048 }
    const { container } = render(<PreviewCard token={file({ label: 'form.css', path: '/w/form.css' })} data={data} variant="side" />)
    expect((container.firstChild as HTMLElement).style.width).toBe('220px')
    expect(container.querySelector('.ft')).toBeNull()
    expect(container.querySelectorAll('.ln')).toHaveLength(3)
    expect(q(container, '.ph')).toBe('form.css')
  })
})
