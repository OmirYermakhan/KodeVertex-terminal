import { act, fireEvent, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PtyHandle, SpawnOptions } from './ptyClient'

const terms: FakeTerminal[] = []

class FakeTerminal {
  /** Все присваивания fontFamily по порядку. */
  fontHistory: unknown[] = []
  options: Record<string, unknown>
  cols = 80
  rows = 24
  unicode = { activeVersion: '6' }
  parser = { registerOscHandler: vi.fn() }
  write = vi.fn()
  dispose = vi.fn()
  focus = vi.fn()
  loadAddon = vi.fn()
  open = vi.fn()
  attachCustomKeyEventHandler = vi.fn()
  hasSelection = () => false
  getSelection = () => ''
  paste = vi.fn()
  onData = vi.fn()
  onResize = vi.fn()
  onScroll = vi.fn()
  onWriteParsed = vi.fn()
  clearTextureAtlas = vi.fn()
  reset = vi.fn()
  refresh = vi.fn()
  /** Строки активного буфера (для заморозки блока). */
  lines: string[] = []
  buffer = ((t: FakeTerminal) => ({
    active: {
      type: 'normal',
      cursorX: 5,
      cursorY: 3,
      baseY: 0,
      viewportY: 0,
      get length() {
        return t.lines.length
      },
      getLine: (i: number) => {
        const l = t.lines[i]
        return l === undefined ? undefined : { translateToString: () => l }
      },
    },
    onBufferChange: vi.fn(),
  }))(this)
  element: HTMLElement | undefined = undefined
  constructor(opts: Record<string, unknown>) {
    const history = this.fontHistory
    this.options = new Proxy({ ...opts }, {
      set(target, key, value) {
        if (key === 'fontFamily') history.push(value)
        target[key as string] = value
        return true
      },
    })
    terms.push(this)
  }
}

const addons: FakeAddon[] = []

class FakeAddon {
  constructor() {
    addons.push(this)
  }
  fit = vi.fn()
  onContextLoss = vi.fn()
  dispose = vi.fn()
}

vi.mock('@xterm/xterm', () => ({ Terminal: FakeTerminal }))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: FakeAddon }))
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: FakeAddon }))
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: FakeAddon }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: FakeAddon }))
const serializeAsHTML = vi.fn(
  () => "<html><body><!--StartFragment--><pre><div style='color: #000000; background-color: #ffffff;'><div><span>out1</span></div><div><span>out2</span></div></div></pre><!--EndFragment--></body></html>",
)
vi.mock('@xterm/addon-serialize', () => ({
  SerializeAddon: class extends FakeAddon {
    serializeAsHTML = serializeAsHTML
  },
}))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }))
vi.mock('@tauri-apps/api/path', () => ({ homeDir: () => Promise.resolve('/h') }))
const invoke = vi.fn()
class FakeChannel<T> {
  onmessage: (m: T) => void
  constructor(onmessage: (m: T) => void) {
    this.onmessage = onmessage
  }
}
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a), Channel: FakeChannel }))

interface PendingSpawn {
  opts: SpawnOptions
  handle: { id: string; write: ReturnType<typeof vi.fn>; resize: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn> }
  resolve: () => void
}
const spawns: PendingSpawn[] = []

vi.mock('./ptyClient', () => ({
  spawnPty: (opts: SpawnOptions) =>
    new Promise<PtyHandle>((res) => {
      const handle = { id: `s${spawns.length}`, write: vi.fn(), resize: vi.fn(), kill: vi.fn() }
      spawns.push({ opts, handle, resolve: () => res(handle) })
    }),
}))

globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
  unobserve() {}
} as unknown as typeof ResizeObserver

const { TerminalPane } = await import('./TerminalPane')
const { useUi } = await import('../ui/uiStore')
const { useSettings } = await import('../settings/store')
const { DEFAULTS, terminalLineHeight } = await import('../settings/settings')
const { codeFontStack } = await import('../theme/fontFamily')
const { runPaneCommand } = await import('../feed/paneCommands')
const { getHistory, resetHistory } = await import('../input/history')
const { useClaudeSessions } = await import('../claude/sessionStore')
const { mockupScene } = await import('../claude/fixtures/mockupScene')
const { runAction } = await import('../keys/actions')

const flush = (ms = 0) => new Promise((r) => setTimeout(r, ms))

type OscHandler = (data: string) => boolean
type KeyHandler = (e: KeyboardEvent) => boolean
const oscHandler = (t: FakeTerminal, id: number) =>
  t.parser.registerOscHandler.mock.calls.find((c) => c[0] === id)![1] as OscHandler
const oscHandlerOf = (t: FakeTerminal) => oscHandler(t, 133)
const keyHandler = (t: FakeTerminal) => t.attachCustomKeyEventHandler.mock.calls[0][0] as KeyHandler
const textarea = () => document.querySelector<HTMLTextAreaElement>('.in-ta')!
/** Набор в строке ввода: значение и курсор в конце. */
const type = (v: string) => fireEvent.change(textarea(), { target: { value: v, selectionStart: v.length, selectionEnd: v.length } })
const keyIn = (key: string, o: KeyboardEventInit = {}) => fireEvent.keyDown(textarea(), { key, ...o })

function props() {
  return { paneId: 'p', focused: false, onCwd: vi.fn(), onExit: vi.fn(), onFocus: vi.fn() }
}

describe('TerminalPane', () => {
  beforeEach(() => {
    terms.length = 0
    spawns.length = 0
    addons.length = 0
    useUi.setState({ settingsOpen: false, agentsHidden: false })
    useSettings.setState({ settings: { ...DEFAULTS } })
    invoke.mockReset()
    resetHistory()
    useClaudeSessions.setState({ sessions: {} })
  })

  it('фокус в строку ввода при закрытии настроек', () => {
    useUi.setState({ settingsOpen: true })
    render(<TerminalPane {...props()} focused />)
    expect(document.activeElement).not.toBe(textarea())
    act(() => useUi.setState({ settingsOpen: false }))
    expect(document.activeElement).toBe(textarea())
    expect(terms[0].focus).not.toHaveBeenCalled()
  })

  describe('строка ввода', () => {
    async function mounted(focused = true) {
      const r = render(<TerminalPane {...props()} focused={focused} initialCwd="/w" />)
      spawns[0].resolve()
      await flush()
      return { ...r, term: terms[0], write: spawns[0].handle.write }
    }

    it('↵ пишет команду в PTY и добавляет её в историю; ↑ её возвращает', async () => {
      const { write } = await mounted()
      type('ls -la')
      keyIn('Enter')
      expect(write).toHaveBeenCalledWith('\x1b[200~ls -la\x1b[201~\r')
      expect(textarea().value).toBe('')
      expect(getHistory()).toEqual(['ls -la'])
      keyIn('ArrowUp')
      expect(textarea().value).toBe('ls -la')
    })

    it('многострочная команда уходит одной строкой ZLE (bracketed paste)', async () => {
      const { write } = await mounted()
      type('for i in 1 2\ndo echo $i; done')
      keyIn('Enter')
      expect(write).toHaveBeenCalledWith('\x1b[200~for i in 1 2\ndo echo $i; done\x1b[201~\r')
    })

    it('управляющие символы вырезаются: `\x1b[201~` внутри не завершает paste раньше времени', async () => {
      const { write } = await mounted()
      type('echo a\x1b[201~; rm -rf x\x03')
      keyIn('Enter')
      expect(write).toHaveBeenCalledWith('\x1b[200~echo a[201~; rm -rf x\x1b[201~\r')
    })

    it('оболочка ещё не запущена — команда остаётся в строке', async () => {
      render(<TerminalPane {...props()} focused initialCwd="/w" />)
      type('ls')
      keyIn('Enter')
      expect(textarea().value).toBe('ls')
      spawns[0].resolve()
      await act(async () => await flush())
      keyIn('Enter')
      expect(spawns[0].handle.write).toHaveBeenCalledWith('\x1b[200~ls\x1b[201~\r')
      expect(textarea().value).toBe('')
    })

    it('незаконченная команда (PS2): подсказка, ⌃C шлёт \x03 и очищает строку; новое приглашение убирает подсказку', async () => {
      const { term, write } = await mounted()
      type('echo "abc')
      keyIn('Enter')
      act(() => void oscHandler(term, 133)('A;k=s'))
      expect(document.querySelector('.in-note')?.textContent).toBe('Команда не закончена — допишите или ⌃C')
      type('def"')
      keyIn('c', { ctrlKey: true })
      expect(write).toHaveBeenLastCalledWith('\x03')
      expect(textarea().value).toBe('')
      act(() => void oscHandler(term, 133)('A'))
      expect(document.querySelector('.in-note')).toBeNull()
      // Продолжение команды — тем же путём; C убирает подсказку.
      act(() => void oscHandler(term, 133)('A;k=s'))
      type('done')
      keyIn('Enter')
      expect(write).toHaveBeenLastCalledWith('\x1b[200~done\x1b[201~\r')
      act(() => void oscHandler(term, 133)('C;' + btoa('for x; do; done')))
      expect(document.querySelector('.in-note')).toBeNull()
    })

    it('⌃C на пустой строке в простое — \x03 в оболочку', async () => {
      const { write } = await mounted()
      keyIn('c', { ctrlKey: true })
      expect(write).toHaveBeenCalledWith('\x03')
    })

    it('⌃D на пустой строке — EOF в оболочку; на непустой — нет', async () => {
      const { write } = await mounted()
      keyIn('d', { ctrlKey: true })
      expect(write).toHaveBeenCalledWith('\x04')
      write.mockClear()
      type('ls')
      keyIn('d', { ctrlKey: true })
      expect(write).not.toHaveBeenCalled()
    })

    it('Tab и ⇧Tab не уводят фокус из строки ввода; спрятанный xterm — inert', async () => {
      await mounted()
      type('echo')
      expect(keyIn('Tab')).toBe(false)
      expect(keyIn('Tab', { shiftKey: true })).toBe(false)
      expect(document.querySelector('.feed-park')!.hasAttribute('inert')).toBe(true)
    })

    it('после ↵ строка неактивна до C или A (второй ↵ не уйдёт в stdin команды)', async () => {
      const { term, write } = await mounted()
      type('ls')
      keyIn('Enter')
      expect(textarea()).toBeDisabled()
      act(() => void oscHandler(term, 133)('A'))
      expect(textarea()).not.toBeDisabled()
      expect(document.activeElement).toBe(textarea())
      // Оболочка молчит — через 2 с строка снова активна.
      type('pwd')
      keyIn('Enter')
      expect(textarea()).toBeDisabled()
      await act(async () => await flush(2100))
      expect(textarea()).not.toBeDisabled()
      expect(write).toHaveBeenCalledTimes(2)
    })

    it('cwd из OSC 7 — только в простое и только от этого компьютера', async () => {
      const onCwd = vi.fn()
      render(<TerminalPane {...props()} onCwd={onCwd} focused initialCwd="/w" />)
      spawns[0].resolve()
      await flush()
      const term = terms[0]
      const osc7 = (d: string) => act(() => void oscHandler(term, 7)(d))
      // Первый OSC 7 — от нашей оболочки: его хост — этот компьютер.
      osc7('file://mac/a')
      // Во время команды (cat файла, ssh) — не принимается.
      act(() => void oscHandler(term, 133)('C;' + btoa('ssh srv')))
      osc7('file://mac/remote')
      act(() => void oscHandler(term, 133)('D;0'))
      // Чужой хост — не принимается; пустой, localhost и свой — да.
      osc7('file://srv/x')
      osc7('file://localhost/b')
      osc7('file:///c')
      osc7('file://MAC/d')
      expect(onCwd.mock.calls.map((c) => c[0])).toEqual(['/a', '/b', '/c', '/d'])
    })

    it('пустая строка не отправляется', async () => {
      const { write } = await mounted()
      type('   ')
      keyIn('Enter')
      expect(write).not.toHaveBeenCalled()
    })

    it('подсказки путей: `cd Док` → Tab → значение поля `cd Документы/`, в PTY ничего', async () => {
      invoke.mockImplementation(async (cmd: string) =>
        cmd === 'fs_list' ? [{ name: 'Документы', isDir: true, isSymlink: false }] : { kind: 'dir', entries: [], total: 0 },
      )
      const { write } = await mounted()
      await act(async () => {
        type('cd Док')
        await flush(40)
      })
      expect(invoke).toHaveBeenCalledWith('fs_list', { dir: '/w', dirsOnly: true, includeHidden: false })
      expect(document.querySelector('.input-wrap .cp')).not.toBeNull()
      keyIn('Tab')
      expect(textarea().value).toBe('cd Документы/')
      expect(write).not.toHaveBeenCalled()
      // esc при открытом попапе закрывает его.
      await act(async () => await flush(40))
      expect(document.querySelector('.cp')).not.toBeNull()
      keyIn('Escape')
      expect(document.querySelector('.cp')).toBeNull()
    })

    it('↵ на cd в попапе подставляет и выполняет', async () => {
      invoke.mockImplementation(async (cmd: string) =>
        cmd === 'fs_list' ? [{ name: 'src', isDir: true, isSymlink: false }] : { kind: 'dir', entries: [], total: 0 },
      )
      const { write } = await mounted()
      await act(async () => {
        type('cd sr')
        await flush(40)
      })
      keyIn('Enter')
      expect(write).toHaveBeenCalledWith('\x1b[200~cd src\x1b[201~\r')
    })

    it('cwd подсказок — из OSC 7', async () => {
      invoke.mockResolvedValue([{ name: 'src', isDir: true, isSymlink: false }])
      const { term } = await mounted()
      await act(async () => {
        oscHandler(term, 7)('file://host/q')
        type('cd sr')
        await flush(40)
      })
      expect(invoke).toHaveBeenCalledWith('fs_list', { dir: '/q', dirsOnly: true, includeHidden: false })
    })

    it('фоновая панель и выключенные подсказки — без попапа', async () => {
      invoke.mockResolvedValue([{ name: 'src', isDir: true, isSymlink: false }])
      useSettings.setState({ settings: { ...DEFAULTS, pathCompletions: false } })
      await mounted()
      await act(async () => {
        type('cd sr')
        await flush(40)
      })
      expect(invoke).not.toHaveBeenCalledWith('fs_list', expect.anything())
      expect(document.querySelector('.cp')).toBeNull()
    })

    it('⇧↵ не отправляет (перенос строки — поведение поля)', async () => {
      const { write } = await mounted()
      type('echo a')
      const ev = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true })
      textarea().dispatchEvent(ev)
      expect(ev.defaultPrevented).toBe(false)
      expect(write).not.toHaveBeenCalled()
    })

    it('⌃C очищает строку; ⌃L очищает ленту, id новых блоков не повторяются', async () => {
      const { term } = await mounted()
      type('abc')
      keyIn('c', { ctrlKey: true })
      expect(textarea().value).toBe('')
      for (const c of ['a', 'b']) {
        act(() => void oscHandler(term, 133)('C;' + btoa(c)))
        act(() => void oscHandler(term, 133)('D;0'))
      }
      const ids = () => Array.from(document.querySelectorAll('.feed [data-block-id]')).map((e) => e.getAttribute('data-block-id'))
      const before = ids()
      expect(before).toHaveLength(2)
      keyIn('l', { ctrlKey: true })
      expect(ids()).toEqual([])
      act(() => void oscHandler(term, 133)('C;' + btoa('c')))
      act(() => void oscHandler(term, 133)('D;0'))
      expect(ids()).toHaveLength(1)
      expect(before).not.toContain(ids()[0])
    })

    describe('Claude', () => {
      type Call = [string, Record<string, unknown>]
      const calls = () => invoke.mock.calls as Call[]
      const startArgs = () => calls().find((c) => c[0] === 'claude_start')![1] as {
        onLine: { onmessage: (l: string) => void }
        onExit: { onmessage: (e: { code: number | null; stderr: string }) => void }
      }
      function claudeOk() {
        invoke.mockImplementation(async (cmd: string) => (cmd === 'claude_start' ? 'c1' : undefined))
      }

      it('⌘↵: карточка «Вы» сразу, claude_start в cwd панели, затем claude_send; второй — только send', async () => {
        claudeOk()
        await mounted()
        type('что тут?')
        keyIn('Enter', { metaKey: true })
        expect(textarea().value).toBe('')
        expect(document.querySelector('.you')?.textContent).toContain('что тут?')
        await act(async () => await flush())
        // claude_control — запрос текущих модели и усилия после запуска.
        const names = calls().map((c) => c[0]).filter((n) => n.startsWith('claude'))
        expect(names).toEqual(['claude_start', 'claude_control', 'claude_send'])
        expect(calls().find((c) => c[0] === 'claude_start')![1]).toMatchObject({ cwd: '/w', resume: null })
        expect(calls().find((c) => c[0] === 'claude_send')![1]).toEqual({ id: 'c1', text: 'что тут?' })
        // Вопрос Claude не попадает в историю команд.
        expect(getHistory()).toEqual([])

        // Ход закончился — следующее сообщение уходит сразу (во время хода оно ждало бы в очереди).
        act(() => startArgs().onLine.onmessage(JSON.stringify({ type: 'result', result: 'ok' })))
        type('ещё')
        keyIn('Enter', { metaKey: true })
        await act(async () => await flush())
        expect(calls().map((c) => c[0]).filter((n) => n.startsWith('claude'))).toEqual(['claude_start', 'claude_control', 'claude_send', 'claude_send'])
      })

      it('`claude` и `claude <вопрос>` сначала очищают ленту от прежних команд', async () => {
        claudeOk()
        const { term } = await mounted()
        const blocks = () => document.querySelectorAll('.feed [data-block-id]').length
        for (const c of ['ls', 'pwd']) {
          act(() => void oscHandler(term, 133)('C;' + btoa(c)))
          act(() => void oscHandler(term, 133)('D;0'))
        }
        expect(blocks()).toBe(2)
        type('claude')
        keyIn('Enter')
        await act(async () => await flush())
        expect(blocks()).toBe(0)
        expect(document.querySelector('.feed .cl-note')?.textContent).toContain('Claude')
        // Новые блоки после выхода из режима видны, id не повторяются.
        type('/exit')
        keyIn('Enter')
        act(() => void oscHandler(term, 133)('C;' + btoa('date')))
        act(() => void oscHandler(term, 133)('D;0'))
        expect(blocks()).toBe(1)
        type('claude что тут?')
        keyIn('Enter')
        await act(async () => await flush())
        expect(blocks()).toBe(0)
        expect(document.querySelector('.feed .you')?.textContent).toContain('что тут?')
      })

      it('вопрос агента: блок над строкой ввода с фокусом, в ленте — «ждёт ответа»; ответ уходит, блок исчезает', async () => {
        claudeOk()
        await mounted()
        type('claude')
        keyIn('Enter')
        await act(async () => await flush())
        const input = {
          questions: [{ question: 'Какую базу?', header: 'База', multiSelect: false, options: [{ label: 'Postgres (Recommended)', description: 'надёжно' }, { label: 'SQLite', description: 'просто' }] }],
        }
        act(() =>
          startArgs().onLine.onmessage(
            JSON.stringify({ type: 'control_request', request_id: 'rq', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input, tool_use_id: 't' } }),
          ),
        )
        const dock = document.querySelector('.dock')!
        const prompt = dock.querySelector('.aprompt') as HTMLElement
        expect(prompt).not.toBeNull()
        // Порядок в доке: панель агентов, вопрос, строка ввода.
        expect([...dock.children].map((c) => c.className.split(' ')[0])).toEqual(['agents', 'aprompt', 'input-wrap'])
        expect(document.activeElement).toBe(prompt)
        expect(document.querySelector('.feed .q-wait')?.textContent).toContain('Какую базу?')
        // esc — к вводу, ⌘↓ — обратно к вопросу.
        fireEvent.keyDown(prompt, { key: 'Escape' })
        expect(document.activeElement).toBe(textarea())
        // «Свой ответ…» — ответ пишется в строке ввода.
        prompt.focus()
        fireEvent.keyDown(prompt, { key: '3' })
        fireEvent.keyDown(prompt, { key: 'Enter' })
        expect(document.activeElement).toBe(textarea())
        expect(textarea().getAttribute('aria-label')).toBe('Ваш ответ на вопрос…')
        type('MySQL')
        keyIn('Enter')
        await act(async () => await flush())
        expect(calls().filter((c) => c[0] === 'claude_respond').map((c) => c[1])).toEqual([
          { id: 'c1', requestId: 'rq', response: { behavior: 'allow', updatedInput: { ...input, answers: { 'Какую базу?': 'MySQL' } } } },
        ])
        expect(document.querySelector('.aprompt')).toBeNull()
        expect(document.querySelector('.feed .qcard .q-ans')?.textContent).toBe('✓ Ответ: MySQL')
        expect(textarea().getAttribute('aria-label')).not.toBe('Ваш ответ на вопрос…')
      })

      it('очередь: пока ход идёт — сообщения в очередь над строкой ввода; ⌘↓ ввод → очередь → агенты; по result — отправка', async () => {
        claudeOk()
        await mounted()
        type('claude')
        keyIn('Enter')
        await act(async () => await flush())
        type('первое')
        keyIn('Enter')
        await act(async () => await flush())
        type('второе')
        keyIn('Enter')
        type('третье')
        keyIn('Enter')
        await act(async () => await flush())
        const sends = () => calls().filter((c) => c[0] === 'claude_send').map((c) => (c[1] as { text: string }).text)
        expect(sends()).toEqual(['первое'])
        const dock = document.querySelector('.dock')!
        expect([...dock.children].map((c) => c.className.split(' ')[0])).toEqual(['agents', 'queue', 'input-wrap'])
        expect([...dock.querySelectorAll('.qu-text')].map((r) => r.textContent)).toEqual(['второе', 'третье'])
        expect(dock.querySelector('.agents .dh')!.textContent).toContain('· 2 в очереди')
        expect([...document.querySelectorAll('.feed .you')].map((r) => r.textContent)).toEqual([expect.stringContaining('первое')])
        // ⌘↓: строка ввода → очередь → панель агентов.
        act(() => runPaneCommand('p', 'blockNext'))
        expect(document.activeElement).toBe(dock.querySelector('.queue'))
        act(() => runPaneCommand('p', 'blockNext'))
        expect(document.activeElement).toBe(dock.querySelector('.agents'))
        // ↑ в пустой строке — последнее обратно в строку.
        textarea().focus()
        keyIn('ArrowUp')
        expect(textarea().value).toBe('третье')
        expect(dock.querySelectorAll('.qu-row')).toHaveLength(1)
        await act(async () => {
          startArgs().onLine.onmessage(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', session_id: 's' }))
          await flush()
        })
        expect(sends()).toEqual(['первое', 'второе'])
        expect(document.querySelector('.queue')).toBeNull()
        expect([...document.querySelectorAll('.feed .you')].map((r) => r.textContent)).toEqual([expect.stringContaining('первое'), expect.stringContaining('второе')])
      })

      it('ответ ↵ на варианте — фокус в строку ввода; разрешение — в том же блоке; при открытом /model фокус не забирается', async () => {
        claudeOk()
        await mounted()
        type('claude')
        keyIn('Enter')
        await act(async () => await flush())
        const ask = (rid: string, tool: string, inp: object) =>
          act(() =>
            startArgs().onLine.onmessage(
              JSON.stringify({ type: 'control_request', request_id: rid, request: { subtype: 'can_use_tool', tool_name: tool, input: inp } }),
            ),
          )
        ask('q1', 'AskUserQuestion', { questions: [{ question: 'Да?', header: '', multiSelect: false, options: [{ label: 'Да', description: '' }] }] })
        const prompt = document.querySelector('.aprompt') as HTMLElement
        expect(document.activeElement).toBe(prompt)
        await act(async () => {
          fireEvent.keyDown(prompt, { key: 'Enter' })
          await flush()
        })
        expect(document.querySelector('.aprompt')).toBeNull()
        expect(document.activeElement).toBe(textarea())

        ask('p1', 'Bash', { command: 'git push' })
        const perm = document.querySelector('.aprompt') as HTMLElement
        expect(perm.querySelector('.ap-who')!.textContent).toContain('! Разрешение')
        expect(document.activeElement).toBe(perm)
        act(() => void fireEvent.keyDown(perm, { key: '2' }))
        await act(async () => {
          fireEvent.keyDown(perm, { key: 'Enter' })
          await flush()
        })
        expect(calls().filter((c) => c[0] === 'claude_respond').map((c) => (c[1] as { response: object }).response).at(-1)).toEqual({
          behavior: 'deny',
          message: 'Пользователь запретил',
        })
        expect(document.querySelector('.feed')!.textContent).toContain('✕ Запрещено: Bash · git push')
        expect(document.activeElement).toBe(textarea())

        // Открыта карточка /model — новый запрос фокус не забирает.
        type('/model')
        keyIn('Enter')
        expect(document.querySelector('.mp')).not.toBeNull()
        ask('p2', 'Bash', { command: 'ls' })
        expect(document.querySelector('.aprompt')).not.toBeNull()
        expect(document.activeElement).toBe(textarea())
      })

      it('ответы Claude — в той же ленте, по времени: блок, вопрос, ответ, следующий блок', async () => {
        claudeOk()
        const { term } = await mounted()
        act(() => void oscHandler(term, 133)('C;' + btoa('ls')))
        act(() => void oscHandler(term, 133)('D;0'))
        type('вопрос')
        keyIn('Enter', { metaKey: true })
        await act(async () => await flush())
        act(() =>
          startArgs().onLine.onmessage(
            JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4', content: [{ type: 'text', text: 'ответ' }] } }),
          ),
        )
        act(() => void oscHandler(term, 133)('C;' + btoa('pwd')))
        act(() => void oscHandler(term, 133)('D;0'))
        const order = Array.from(document.querySelectorAll('.feed > .blk, .feed > .you, .feed > .card')).map((e) =>
          e.classList.contains('blk') ? 'blk:' + e.querySelector('.cmd')!.textContent : e.classList.contains('you') ? 'you' : 'card',
        )
        expect(order).toEqual(['blk:ls', 'you', 'card', 'blk:pwd'])
        expect(useClaudeSessions.getState().sessions.p.state.agents.length).toBeGreaterThan(0)
      })

      it('выход claude с ошибкой — карточка ошибки с хвостом stderr; следующий ⌘↵ перезапускает с --resume', async () => {
        claudeOk()
        await mounted()
        type('a')
        keyIn('Enter', { metaKey: true })
        await act(async () => await flush())
        act(() => startArgs().onLine.onmessage(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'S1' })))
        act(() => startArgs().onExit.onmessage({ code: 1, stderr: 'boom\n' }))
        expect(document.querySelector('.cerr')?.textContent).toContain('boom')
        expect(useClaudeSessions.getState().sessions.p.state.busy).toBe(false)
        invoke.mockClear()
        type('b')
        keyIn('Enter', { metaKey: true })
        await act(async () => await flush())
        expect(calls().find((c) => c[0] === 'claude_start')![1]).toMatchObject({ resume: 'S1' })
      })

      it('claude не найден — карточка ошибки с текстом', async () => {
        invoke.mockImplementation(async (cmd: string) => {
          if (cmd === 'claude_start') throw 'Claude Code не найден. Установите: npm i -g @anthropic-ai/claude-code'
        })
        await mounted()
        type('a')
        keyIn('Enter', { metaKey: true })
        await act(async () => await flush())
        expect(document.querySelector('.cerr')?.textContent).toContain('Claude Code не найден')
        expect(calls().some((c) => c[0] === 'claude_send')).toBe(false)
      })

      it('⌃C при занятом Claude — claude_interrupt, строка не очищается; выход после него — не ошибка', async () => {
        claudeOk()
        await mounted()
        type('a')
        keyIn('Enter', { metaKey: true })
        await act(async () => await flush())
        type('draft')
        keyIn('c', { ctrlKey: true })
        expect(invoke).toHaveBeenCalledWith('claude_interrupt', { id: 'c1' })
        expect(textarea().value).toBe('draft')
        act(() => startArgs().onExit.onmessage({ code: 130, stderr: '' }))
        expect(document.querySelector('.cerr')).toBeNull()
        expect(useClaudeSessions.getState().sessions.p.state.busy).toBe(false)
      })

      const result = () => JSON.stringify({ type: 'result', result: 'ok', duration_ms: 1, total_cost_usd: 0 })

      it('в том же каталоге — --resume; из другого — новая сессия там (старая остановлена); упавший молча --resume сбрасывает sessionId', async () => {
        claudeOk()
        const { term } = await mounted()
        type('a')
        keyIn('Enter', { metaKey: true })
        await act(async () => await flush())
        // Новая сессия — строка с её каталогом перед вопросом.
        expect(document.querySelector('.cl-note')?.textContent).toBe('Claude · /w')
        act(() => startArgs().onLine.onmessage(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'S1' })))
        act(() => startArgs().onLine.onmessage(result()))
        act(() => startArgs().onExit.onmessage({ code: 0, stderr: '' }))
        expect(document.querySelector('.cerr')).toBeNull()
        invoke.mockClear()
        type('b')
        keyIn('Enter', { metaKey: true })
        await act(async () => await flush())
        expect(startArgs()).toMatchObject({ cwd: '/w', resume: 'S1' })
        expect(document.querySelectorAll('.cl-note')).toHaveLength(1)
        act(() => startArgs().onLine.onmessage(result()))
        // Панель перешла в другой каталог, процесс ещё жив: он останавливается, новая сессия — там.
        act(() => void oscHandler(term, 7)('file://host/other'))
        invoke.mockClear()
        type('c')
        keyIn('Enter', { metaKey: true })
        await act(async () => await flush())
        expect(invoke).toHaveBeenCalledWith('claude_stop', { id: 'c1' })
        expect(startArgs()).toMatchObject({ cwd: '/other', resume: null })
        expect(Array.from(document.querySelectorAll('.cl-note')).map((e) => e.textContent)).toEqual(['Claude · /w', 'Claude · /other'])
        act(() => startArgs().onLine.onmessage(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'S2' })))
        act(() => startArgs().onLine.onmessage(result()))
        act(() => startArgs().onExit.onmessage({ code: 0, stderr: '' }))
        invoke.mockClear()
        type('d')
        keyIn('Enter', { metaKey: true })
        await act(async () => await flush())
        expect(startArgs()).toMatchObject({ cwd: '/other', resume: 'S2' })
        // resume не удался: ни одной строки, код 1.
        act(() => startArgs().onExit.onmessage({ code: 1, stderr: 'No conversation found' }))
        expect(useClaudeSessions.getState().sessions.p.state.sessionId).toBeNull()
        invoke.mockClear()
        type('e')
        keyIn('Enter', { metaKey: true })
        await act(async () => await flush())
        expect(startArgs()).toMatchObject({ cwd: '/other', resume: null })
      })

      it('два ⌘↵ подряд: первый result не снимает «занят», ⌃C прерывает второй ход', async () => {
        claudeOk()
        await mounted()
        type('a')
        keyIn('Enter', { metaKey: true })
        type('b')
        keyIn('Enter', { metaKey: true })
        await act(async () => await flush())
        act(() => startArgs().onLine.onmessage(result()))
        const st = () => useClaudeSessions.getState().sessions.p.state
        expect(st().busy).toBe(true)
        expect(st().agents.find((x) => x.id === 'main')!.status).toBe('running')
        keyIn('c', { ctrlKey: true })
        expect(invoke).toHaveBeenCalledWith('claude_interrupt', { id: 'c1' })
        expect(spawns[0].handle.write).not.toHaveBeenCalledWith('\x03')
        act(() => startArgs().onLine.onmessage(result()))
        expect(st().busy).toBe(false)
      })

      it('claude вышел с кодом 0 посреди хода без ⌃C — карточка ошибки', async () => {
        claudeOk()
        await mounted()
        type('a')
        keyIn('Enter', { metaKey: true })
        await act(async () => await flush())
        act(() => startArgs().onExit.onmessage({ code: 0, stderr: '' }))
        expect(document.querySelector('.cerr')?.textContent).toContain('Claude завершился, не закончив ответ')
        expect(useClaudeSessions.getState().sessions.p.state.busy).toBe(false)
      })

      it('каталог панели ещё неизвестен — понятная ошибка по-русски, claude не запускается', async () => {
        claudeOk()
        render(<TerminalPane {...props()} focused />)
        spawns[0].resolve()
        await flush()
        type('a')
        keyIn('Enter', { metaKey: true })
        await act(async () => await flush())
        expect(document.querySelector('.cerr')?.textContent).toContain('Каталог панели ещё неизвестен')
        expect(calls().some((c) => c[0] === 'claude_start')).toBe(false)
      })

      it('⌃L посреди ответа: продолжение ответа появляется', async () => {
        claudeOk()
        await mounted()
        type('a')
        keyIn('Enter', { metaKey: true })
        await act(async () => await flush())
        const delta = (text: string) =>
          JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } })
        act(() => startArgs().onLine.onmessage(delta('нач')))
        keyIn('l', { ctrlKey: true })
        expect(document.querySelector('.you')).toBeNull()
        act(() => startArgs().onLine.onmessage(delta('ало')))
        expect(document.querySelector('.card')?.textContent).toContain('начало')
      })

      it('⌃C, пока процесс запускается: вопрос не отправляется, строка не очищается', async () => {
        let resolveStart!: (id: string) => void
        invoke.mockImplementation((cmd: string) =>
          cmd === 'claude_start' ? new Promise((r) => (resolveStart = r)) : Promise.resolve(undefined),
        )
        await mounted()
        type('a')
        keyIn('Enter', { metaKey: true })
        type('draft')
        keyIn('c', { ctrlKey: true })
        expect(textarea().value).toBe('draft')
        await act(async () => {
          resolveStart('c1')
          await flush()
        })
        expect(calls().some((c) => c[0] === 'claude_send')).toBe(false)
        expect(useClaudeSessions.getState().sessions.p.state.busy).toBe(false)
      })

      it('claude_send идут по очереди', async () => {
        const sends: Array<() => void> = []
        invoke.mockImplementation((cmd: string) => {
          if (cmd === 'claude_start') return Promise.resolve('c1')
          if (cmd === 'claude_send') return new Promise<void>((r) => sends.push(r))
          return Promise.resolve(undefined)
        })
        await mounted()
        type('1')
        keyIn('Enter', { metaKey: true })
        await act(async () => await flush())
        // Ход закончился раньше, чем claude_send вернулся: второе сообщение ждёт первого send.
        const start = calls().find((c) => c[0] === 'claude_start')![1] as { onLine: { onmessage(l: string): void } }
        act(() => start.onLine.onmessage(JSON.stringify({ type: 'result', result: 'ok' })))
        type('2')
        keyIn('Enter', { metaKey: true })
        await act(async () => await flush())
        expect(sends).toHaveLength(1)
        await act(async () => {
          sends[0]()
          await flush()
        })
        expect(sends).toHaveLength(2)
        const texts = calls().filter((c) => c[0] === 'claude_send').map((c) => c[1].text)
        expect(texts).toEqual(['1', '2'])
      })

      it('закрытие панели останавливает процесс claude', async () => {
        claudeOk()
        const { unmount } = await mounted()
        type('a')
        keyIn('Enter', { metaKey: true })
        await act(async () => await flush())
        unmount()
        expect(invoke).toHaveBeenCalledWith('claude_stop', { id: 'c1' })
        expect(useClaudeSessions.getState().sessions.p).toBeUndefined()
      })
    })
  })

  it('kills a session that resolves after unmount and ignores its output/exit', async () => {
    const p = props()
    const { unmount } = render(<TerminalPane {...p} />)
    unmount()
    spawns[0].resolve()
    await flush()
    expect(spawns[0].handle.kill).toHaveBeenCalled()
    spawns[0].opts.onData(new Uint8Array([1]))
    spawns[0].opts.onExit(null)
    expect(terms[0].write).not.toHaveBeenCalled()
    expect(p.onExit).not.toHaveBeenCalled()
  })

  it('does not report exit caused by its own kill on unmount', async () => {
    const p = props()
    const { unmount } = render(<TerminalPane {...p} />)
    spawns[0].resolve()
    await flush()
    unmount()
    expect(spawns[0].handle.kill).toHaveBeenCalled()
    spawns[0].opts.onExit(0)
    expect(p.onExit).not.toHaveBeenCalled()
  })

  it('reports a real exit while mounted', async () => {
    const p = props()
    render(<TerminalPane {...p} />)
    spawns[0].resolve()
    await flush()
    spawns[0].opts.onData(new Uint8Array([104]))
    spawns[0].opts.onExit(0)
    expect(terms[0].write).toHaveBeenCalledWith(new Uint8Array([104]))
    expect(p.onExit).toHaveBeenCalledTimes(1)
  })

  it('syncs the size that changed while pty_spawn was in flight', async () => {
    render(<TerminalPane {...props()} />)
    expect(spawns[0].opts).toMatchObject({ cols: 80, rows: 24 })
    const term = terms[0]
    term.cols = 120
    term.rows = 40
    const onResize = term.onResize.mock.calls[0][0] as (s: { cols: number; rows: number }) => void
    onResize({ cols: 120, rows: 40 }) // dropped: no handle yet
    spawns[0].resolve()
    await flush()
    expect(spawns[0].handle.resize).toHaveBeenCalledWith(120, 40)
  })

  it('does not kill a session that already exited on its own', async () => {
    const p = props()
    const { unmount } = render(<TerminalPane {...p} />)
    spawns[0].resolve()
    await flush()
    spawns[0].opts.onExit(0)
    unmount()
    expect(spawns[0].handle.kill).not.toHaveBeenCalled()
  })

  it('re-measures the font after it finishes loading, then fits', async () => {
    let loaded!: () => void
    const load = vi.fn(() => new Promise<void>((r) => (loaded = r)))
    Object.defineProperty(document, 'fonts', { value: { load }, configurable: true })
    try {
      render(<TerminalPane {...props()} />)
      const term = terms[0]
      const fit = addons[0].fit
      act(() => useSettings.setState({ settings: { ...DEFAULTS, codeFont: 'Fira Code' } }))
      const stack = codeFontStack('Fira Code')
      expect(load).toHaveBeenLastCalledWith(`${DEFAULTS.codeSize}px ${stack}`)
      term.fontHistory.length = 0
      fit.mockClear()
      loaded()
      await flush()
      // Семейство меняется туда и обратно — xterm перемеряет ячейку.
      expect(term.fontHistory).toEqual(['monospace', stack])
      expect(term.clearTextureAtlas).toHaveBeenCalled()
      expect(fit).toHaveBeenCalled()
    } finally {
      delete (document as { fonts?: unknown }).fonts
    }
  })

  describe('лента', () => {
    const b64 = (x: string) => btoa(x)
    async function mounted(focused = true) {
      const r = render(<TerminalPane {...props()} focused={focused} initialCwd="/w" />)
      spawns[0].resolve()
      await flush()
      return { ...r, term: terms[0] }
    }
    const osc133 = (term: FakeTerminal, data: string) => act(() => void oscHandler(term, 133)(data))
    const bufferChange = (term: FakeTerminal, type: string) =>
      act(() => (term.buffer.onBufferChange.mock.calls[0][0] as (b: { type: string }) => void)({ type }))
    const host = () => document.querySelector('.live-host')!

    it('без команды xterm стоит в невидимой парковке ленты', async () => {
      await mounted()
      expect(host().closest('.feed-park')).not.toBeNull()
      expect(document.querySelector('.blk.run')).toBeNull()
    })

    it('start: reset и running-блок с живым терминалом; end: замороженный HTML без обёртки', async () => {
      const { term } = await mounted()
      osc133(term, 'C;' + b64('ls -la'))
      expect(term.reset).toHaveBeenCalledTimes(1)
      const blk = document.querySelector('.blk.run')!
      expect(blk.querySelector('.cmd')!.textContent).toBe('ls -la')
      expect(blk.querySelector('[data-testid="live-block"]')!.contains(host())).toBe(true)
      expect(term.focus).toHaveBeenCalled()

      term.lines = ['out1', 'out2', '', '']
      osc133(term, 'D;0')
      expect(serializeAsHTML).toHaveBeenLastCalledWith({
        includeGlobalBackground: false,
        range: { startLine: 0, endLine: 1, startCol: 0 },
      })
      expect(document.querySelector('.blk.run')).toBeNull()
      const out = document.querySelector('.blk .out')!
      expect(out.innerHTML).toBe('<div><span>out1</span></div><div><span>out2</span></div>')
      expect(host().closest('.feed-park')).not.toBeNull()
    })

    it('ненулевой код выхода — блок .err и «exit N»', async () => {
      const { term } = await mounted()
      osc133(term, 'C;' + b64('false'))
      osc133(term, 'D;1')
      const blk = document.querySelector('.blk')!
      expect(blk).toHaveClass('err')
      expect(blk.querySelector('.exit')!.textContent).toBe('exit 1')
    })

    it('alt screen: xterm поверх панели с фокусом, после выхода — обратно в блок', async () => {
      const { term } = await mounted()
      osc133(term, 'C;' + b64('vim'))
      term.focus.mockClear()
      bufferChange(term, 'alternate')
      const overlay = document.querySelector('[data-testid="live-overlay"]')!
      expect(overlay.contains(host())).toBe(true)
      expect(document.querySelector('[data-testid="live-block"]')).toBeNull()
      expect(term.focus).toHaveBeenCalled()
      bufferChange(term, 'normal')
      expect(document.querySelector('[data-testid="live-overlay"]')).toBeNull()
      expect(document.querySelector('[data-testid="live-block"]')!.contains(host())).toBe(true)
    })

    it('⌘↑/⌘↓ выбирают блок, ⌘⇧C копирует его вывод текстом', async () => {
      const writeText = vi.fn(() => Promise.resolve())
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
      const { term } = await mounted()
      for (const c of ['a', 'b']) {
        osc133(term, 'C;' + b64(c))
        term.lines = ['out1', 'out2']
        osc133(term, 'D;0')
      }
      const blocks = () => Array.from(document.querySelectorAll('.blk:not(.feed-park .blk)'))
      act(() => runPaneCommand('p', 'blockPrev'))
      expect(blocks().map((b) => b.classList.contains('sel'))).toEqual([false, true])
      act(() => runPaneCommand('p', 'blockPrev'))
      expect(blocks().map((b) => b.classList.contains('sel'))).toEqual([true, false])
      act(() => runPaneCommand('p', 'blockCopy'))
      expect(writeText).toHaveBeenCalledWith('out1\nout2')
      act(() => runPaneCommand('p', 'blockNext'))
      act(() => runPaneCommand('p', 'blockNext'))
      expect(document.querySelector('.blk.sel')).toBeNull()
    })

    it('хоткеи блоков не уходят в xterm', async () => {
      const { term } = await mounted()
      const k = (o: KeyboardEventInit) => keyHandler(term)(new KeyboardEvent('keydown', o))
      expect(k({ code: 'ArrowUp', key: 'ArrowUp', metaKey: true })).toBe(false)
      expect(k({ code: 'KeyC', key: 'C', metaKey: true, shiftKey: true })).toBe(false)
    })

    it('пока идёт команда, строка ввода неактивна; после конца фокус возвращается в неё', async () => {
      const { term } = await mounted()
      expect(document.activeElement).toBe(textarea())
      osc133(term, 'C;' + b64('ls'))
      expect(textarea()).toBeDisabled()
      osc133(term, 'D;0')
      expect(host().closest('.feed-park')).not.toBeNull()
      expect(textarea()).not.toBeDisabled()
      expect(document.activeElement).toBe(textarea())
    })

    it('фоновая панель фокус не забирает', async () => {
      const { term } = await mounted(false)
      osc133(term, 'C;' + b64('ls'))
      osc133(term, 'D;0')
      expect(term.focus).not.toHaveBeenCalled()
    })

    it('вывод в том же куске, что и C, сразу растит живой блок', async () => {
      const { term } = await mounted()
      const parsed = term.onWriteParsed.mock.calls[0][0] as () => void
      act(() => {
        // Один write: C, затем вывод — onWriteParsed приходит до коммита React.
        oscHandler(term, 133)('C;' + b64('echo hi; sleep 5'))
        term.buffer.active.cursorY = 2
        parsed()
      })
      const slot = document.querySelector<HTMLElement>('[data-testid="live-block"]')!
      const cell = DEFAULTS.codeSize * terminalLineHeight(DEFAULTS)
      expect(slot.style.height).toBe(`${Math.ceil(3 * cell)}px`)
    })

    it('приглашение во время команды (ssh с интеграцией) не закрывает блок; OSC 7 после него не принимается', async () => {
      const onCwd = vi.fn()
      render(<TerminalPane {...props()} onCwd={onCwd} focused initialCwd="/w" />)
      spawns[0].resolve()
      await flush()
      const term = terms[0]
      act(() => void oscHandler(term, 7)('file://mac/a'))
      osc133(term, 'C;' + b64('ssh srv'))
      osc133(term, 'A')
      const blk = document.querySelector('.blk:not(.feed-park .blk)')!
      expect(blk).toHaveClass('run')
      expect(textarea()).toBeDisabled()
      expect(host().closest('.feed-park')).toBeNull()
      act(() => void oscHandler(term, 7)('file:///remote'))
      expect(onCwd.mock.calls.map((c) => c[0])).toEqual(['/a'])
    })

    it('вывод вне C…D (ошибка разбора) — отдельный блок с отправленной строкой; обычное приглашение блоков не добавляет', async () => {
      const { term } = await mounted()
      const blocks = () => Array.from(document.querySelectorAll('.blk:not(.feed-park .blk)'))
      osc133(term, 'C;' + b64('ls'))
      term.lines = ['out1']
      osc133(term, 'D;0')
      osc133(term, 'A')
      expect(blocks()).toHaveLength(1)
      term.lines = []
      type('ls )')
      keyIn('Enter')
      osc133(term, 'I')
      term.lines = ["zsh: parse error near `)'"]
      osc133(term, 'A')
      expect(blocks()).toHaveLength(2)
      expect(blocks()[1].querySelector('.cmd')!.textContent).toBe('ls )')
      expect(blocks()[1].querySelector('.out')).not.toBeNull()
      expect(textarea()).not.toBeDisabled()
    })

    it('конец команды при активном alt screen — содержимое alt не замораживается', async () => {
      const { term } = await mounted()
      osc133(term, 'C;' + b64('vim'))
      bufferChange(term, 'alternate')
      term.buffer.active.type = 'alternate'
      term.lines = ['~', '~']
      serializeAsHTML.mockClear()
      osc133(term, 'D;0')
      expect(serializeAsHTML).not.toHaveBeenCalled()
      expect(document.querySelector('.blk .out')).toBeNull()
    })

    it('клик по кнопке ленты фокус не трогает; клик по ленте — в строку ввода, во время команды — в xterm', async () => {
      const { term } = await mounted()
      const feed = document.querySelector('.feed')!
      const btn = document.createElement('button')
      feed.appendChild(btn)
      btn.focus()
      fireEvent.mouseUp(btn)
      expect(document.activeElement).toBe(btn)
      fireEvent.mouseUp(feed)
      expect(document.activeElement).toBe(textarea())
      osc133(term, 'C;' + b64('sleep 9'))
      term.focus.mockClear()
      fireEvent.mouseUp(feed)
      expect(term.focus).toHaveBeenCalled()
      btn.remove()
    })
  })

  describe('панель агентов', () => {
    async function mounted() {
      const r = render(<TerminalPane {...props()} focused initialCwd="/w" />)
      spawns[0].resolve()
      await flush()
      return r
    }
    const withSession = () =>
      act(() => useClaudeSessions.setState({ sessions: { p: { state: mockupScene(), procId: 'c1', cwd: '/w', model: null, effort: null, queue: [], paused: false, pauseHint: false } } }))
    const panel = () => document.querySelector<HTMLElement>('.dock .agents')

    it('без Claude-сессии панели нет; с сессией — в доке над строкой ввода', async () => {
      await mounted()
      expect(panel()).toBeNull()
      withSession()
      expect(panel()).not.toBeNull()
      expect(panel()!.nextElementSibling!.contains(textarea())).toBe(true)
      expect(panel()!.querySelectorAll('.row')).toHaveLength(4)
    })

    it('⌘↓ из строки ввода — фокус в панель, ↑↓ выбор, esc — назад к вводу', async () => {
      await mounted()
      withSession()
      expect(document.activeElement).toBe(textarea())
      act(() => runPaneCommand('p', 'blockNext'))
      expect(document.activeElement).toBe(panel())
      expect(document.querySelector('.row.focus')!.getAttribute('data-agent-id')).toBe('arch')
      fireEvent.keyDown(panel()!, { key: 'ArrowDown' })
      expect(document.querySelector('.row.focus')!.getAttribute('data-agent-id')).toBe('css')
      fireEvent.keyDown(panel()!, { key: 'Escape' })
      expect(document.activeElement).toBe(textarea())
    })

    it('⌘↓ с последнего блока — тоже в панель', async () => {
      const { container } = await mounted()
      withSession()
      const term = terms[0]
      act(() => void oscHandlerOf(term)('C;' + btoa('ls')))
      act(() => void oscHandlerOf(term)('D;0'))
      act(() => runPaneCommand('p', 'blockPrev'))
      expect(container.querySelector('.blk.sel')).not.toBeNull()
      act(() => runPaneCommand('p', 'blockNext'))
      expect(container.querySelector('.blk.sel')).toBeNull()
      expect(document.activeElement).toBe(panel())
    })

    it('⌘J скрывает и показывает панель; фокус из скрытой панели — в строку ввода', async () => {
      await mounted()
      withSession()
      act(() => runPaneCommand('p', 'blockNext'))
      expect(document.activeElement).toBe(panel())
      act(() => runAction('toggleAgents'))
      expect(panel()).toBeNull()
      expect(document.activeElement).toBe(textarea())
      // Скрытая панель: ⌘↓ фокус не уводит.
      act(() => runPaneCommand('p', 'blockNext'))
      expect(document.activeElement).toBe(textarea())
      act(() => runAction('toggleAgents'))
      expect(panel()).not.toBeNull()
    })

    it('сессия исчезла, пока фокус был в панели, — фокус в строку ввода', async () => {
      await mounted()
      withSession()
      act(() => runPaneCommand('p', 'blockNext'))
      expect(document.activeElement).toBe(panel())
      act(() => useClaudeSessions.setState({ sessions: {} }))
      expect(panel()).toBeNull()
      expect(document.activeElement).toBe(textarea())
    })

    it('клик по строке агента не уводит фокус в строку ввода', async () => {
      await mounted()
      withSession()
      const row = document.querySelector('[data-agent-id="main"]')!
      fireEvent.mouseUp(row)
      fireEvent.click(row)
      expect(document.activeElement).toBe(panel())
      expect(row).toHaveClass('focus')
    })
  })
})
