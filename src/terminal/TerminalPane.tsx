import { FitAddon } from '@xterm/addon-fit'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal, type ITerminalOptions } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { openUrl } from '@tauri-apps/plugin-opener'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { terminalLineHeight, type Settings } from '../settings/settings'
import { useSettings } from '../settings/store'
import { useUi } from '../ui/uiStore'
import { codeFontStack } from '../theme/fontFamily'
import { ansiFromTokens, THEMES } from '../theme/themes'
import { matchKey } from '../keys/keymap'
import { parseOsc7 } from './osc'
import { useHome } from '../status/useGitInfo'
import { spawnPty, type PtyHandle } from './ptyClient'
import { applyShell, commandBytes, moveSelection, parseOsc133, syncClaude, type FeedItem, type ShellBlock } from '../feed/feed'
import type { FeedClaudeItem } from '../claude/reducer'
import { askClaude, interruptClaude, stopClaude, useClaudeSessions } from '../claude/sessionStore'
import { InputBar, type InputBarHandle } from '../input/InputBar'
import { AgentsPanel, type AgentsPanelHandle } from '../claude/AgentsPanel'
import { blockText, cleanSerializedHtml } from '../feed/blockHtml'
import { Feed } from '../feed/FeedView'
import { LiveTerminal } from '../feed/LiveTerminal'
import { registerPaneCommands, type BlockAction } from '../feed/paneCommands'

const RESIZE_DEBOUNCE_MS = 50
/** Живой терминал внутри блока — не выше этой доли ленты, дальше скролл внутри xterm. */
const LIVE_MAX_SHARE = 0.6
const LIVE_MIN_HEIGHT = 80
/** «У низа» ленты: автопрокрутка продолжается. */
const STICK_PX = 24

export interface TerminalPaneProps {
  paneId: string
  focused: boolean
  initialCwd?: string
  onCwd: (cwd: string) => void
  onExit: () => void
  onFocus: () => void
}

function appearance(s: Settings): Pick<ITerminalOptions, 'fontFamily' | 'fontSize' | 'lineHeight' | 'theme'> {
  return {
    fontFamily: codeFontStack(s.codeFont),
    fontSize: s.codeSize,
    lineHeight: terminalLineHeight(s),
    theme: ansiFromTokens(THEMES[s.theme].tokens, THEMES[s.theme].dark),
  }
}

/**
 * xterm замеряет ячейку только при смене fontFamily. Если шрифт догрузился позже
 * (встроенный @fontsource грузится лениво), замеры остались от запасного шрифта —
 * переключаем семейство туда и обратно, чтобы xterm перемерил и перерисовал атлас.
 */
function remeasureFont(term: Terminal): void {
  const family = term.options.fontFamily
  term.options.fontFamily = 'monospace'
  term.options.fontFamily = family
  term.clearTextureAtlas()
}

const NO_CLAUDE_ITEMS: readonly FeedClaudeItem[] = []

/** Число строк вывода: индекс последней непустой строки активного буфера + 1. */
function contentLines(term: Terminal): number {
  const buf = term.buffer.active
  for (let i = buf.length - 1; i >= 0; i--) {
    if (buf.getLine(i)?.translateToString(true).trim()) return i + 1
  }
  return 0
}

/** Конец команды: вывод из буфера xterm → HTML блока (только из SerializeAddon). */
function freeze(term: Terminal, ser: SerializeAddon): { html: string; lines: number } {
  const lines = contentLines(term)
  if (lines === 0) return { html: '', lines: 0 }
  const raw = ser.serializeAsHTML({ includeGlobalBackground: false, range: { startLine: 0, endLine: lines - 1, startCol: 0 } })
  return { html: cleanSerializedHtml(raw), lines }
}

/** Сколько строк экрана занято, пока команда идёт: по ним — высота живого блока. */
function usedRows(term: Terminal): number {
  const buf = term.buffer.active
  if (buf.baseY > 0) return term.rows
  let used = buf.cursorY + 1
  for (let i = term.rows - 1; i >= used; i--) {
    if (buf.getLine(i)?.translateToString(true).trim()) return i + 1
  }
  return used
}

function cellHeight(term: Terminal): number {
  const screen = term.element?.querySelector<HTMLElement>('.xterm-screen')
  if (screen && term.rows > 0 && screen.clientHeight > 0) return screen.clientHeight / term.rows
  const s = useSettings.getState().settings
  return s.codeSize * terminalLineHeight(s)
}

function liveContentHeight(term: Terminal): number {
  return Math.ceil(usedRows(term) * cellHeight(term))
}

export function TerminalPane(p: TerminalPaneProps) {
  // Один xterm на панель; его host переносится между «парковкой», running-блоком и оверлеем.
  const [host] = useState(() => {
    const el = document.createElement('div')
    el.className = 'live-host'
    return el
  })
  const parkRef = useRef<HTMLDivElement>(null)
  const feedRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const callbacks = useRef(p)
  useEffect(() => {
    callbacks.current = p
  })

  const handleRef = useRef<PtyHandle | null>(null)
  const inputRef = useRef<InputBarHandle>(null)
  const agentsRef = useRef<AgentsPanelHandle>(null)
  // cwd панели (подсказки путей, Claude-сессия): initialCwd, затем OSC 7.
  const cwdRef = useRef(p.initialCwd)
  const home = useHome()

  const settings = useSettings((st) => st.settings)
  const settingsOpen = useUi((st) => st.settingsOpen)
  const agentsHidden = useUi((st) => st.agentsHidden)

  const [items, setItems] = useState<FeedItem[]>([])
  const itemsRef = useRef(items)
  useEffect(() => {
    itemsRef.current = items
  })
  const [selected, setSelected] = useState<string | null>(null)
  const selectedRef = useRef(selected)
  useEffect(() => {
    selectedRef.current = selected
  })
  const [alt, setAlt] = useState(false)
  const altRef = useRef(alt)
  useEffect(() => {
    altRef.current = alt
  })
  // Высота занятых строк живого терминала, px.
  const [livePx, setLivePx] = useState(0)
  const [feedHeight, setFeedHeight] = useState(0)
  const hostHeight = Math.max(LIVE_MIN_HEIGHT, Math.floor(feedHeight * LIVE_MAX_SHARE))
  // Идёт команда (между OSC 133 C и D). Ставится синхронно в обработчике OSC, не из состояния.
  const runningRef = useRef(false)
  // То же для рендера: строка ввода неактивна, пока идёт команда.
  const [running, setRunning] = useState(false)
  // ZLE во вторичном приглашении (PS2): команда не закончена.
  const [cont, setCont] = useState(false)
  const contRef = useRef(false)
  const setContinuation = (v: boolean) => {
    contRef.current = v
    setCont(v)
  }

  // Claude-сессия панели (стор по paneId): её элементы — в той же ленте, по времени появления.
  const claude = useClaudeSessions((st) => st.sessions[p.paneId])
  const claudeItems = claude?.state.items ?? NO_CLAUDE_ITEMS
  const claudePrev = useRef<readonly FeedClaudeItem[]>(NO_CLAUDE_ITEMS)
  // ⌃L: элементы Claude с индексом меньше этого в ленте больше не показываются.
  const claudeFrom = useRef(0)
  useEffect(() => {
    const prev = claudePrev.current
    const from = claudeFrom.current
    claudePrev.current = claudeItems
    if (prev !== claudeItems) setItems((it) => syncClaude(it, prev, claudeItems, from))
  }, [claudeItems])
  useEffect(() => {
    const paneId = p.paneId
    return () => stopClaude(paneId)
  }, [p.paneId])

  // Create xterm + PTY once per pane.
  useEffect(() => {
    const park = parkRef.current
    if (!park) return
    host.style.height = `${Math.max(LIVE_MIN_HEIGHT, Math.floor((feedRef.current?.clientHeight ?? 0) * LIVE_MAX_SHARE))}px`
    park.appendChild(host)

    const term = new Terminal({
      ...appearance(useSettings.getState().settings),
      allowProposedApi: true,
      macOptionIsMeta: true,
      scrollback: 10000,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    const serializer = new SerializeAddon()
    term.loadAddon(serializer)
    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = '11'
    term.loadAddon(
      new WebLinksAddon((_e, uri) => {
        openUrl(uri).catch((err) => console.error('openUrl failed:', err))
      }),
    )
    term.open(host)
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose()) // xterm falls back to the DOM renderer
      term.loadAddon(webgl)
    } catch (err) {
      console.warn('WebGL renderer unavailable, using DOM renderer:', err)
    }
    fit.fit()
    termRef.current = term
    fitRef.current = fit

    let handle: PtyHandle | null = null
    let disposed = false
    // Оболочка уже завершилась сама: сессии на стороне Rust больше нет, kill не нужен.
    let exited = false

    term.parser.registerOscHandler(7, (data) => {
      const cwd = parseOsc7(data)
      if (cwd) {
        cwdRef.current = cwd
        callbacks.current.onCwd(cwd)
      }
      return true
    })

    // Блоки: zsh сообщает начало (C) и конец (D) команды.
    term.parser.registerOscHandler(133, (data) => {
      const ev = parseOsc133(data)
      if (!ev) return true
      if (ev.t === 'prompt' || ev.t === 'continue') {
        setContinuation(ev.t === 'continue')
        return true
      }
      setContinuation(false)
      const at = Date.now()
      if (ev.t === 'start') {
        // Стираем эхо набранной строки ZLE — в живом терминале только вывод команды.
        term.reset()
        // Синхронно: вывод из того же куска данных (onWriteParsed) уже должен считаться живым.
        runningRef.current = true
        setRunning(true)
        setLivePx(liveContentHeight(term))
        setItems((it) => applyShell(it, { t: 'start', command: ev.command, cwd: cwdRef.current ?? '', at }))
      } else {
        runningRef.current = false
        setRunning(false)
        // Конец пришёл при активном alt screen (программа не вышла из него) — его содержимое не замораживаем.
        const { html, lines } = term.buffer.active.type === 'alternate' ? { html: '', lines: 0 } : freeze(term, serializer)
        setItems((it) => applyShell(it, { t: 'end', exitCode: ev.exitCode, at, html, lines }))
      }
      return true
    })

    // Полноэкранные программы (vim, htop, less) — xterm поверх всей панели.
    term.buffer.onBufferChange((b) => setAlt(b.type === 'alternate'))
    term.onWriteParsed(() => {
      if (runningRef.current) setLivePx(liveContentHeight(term))
    })

    term.attachCustomKeyEventHandler((e) => {
      // App hotkeys are handled globally; keep xterm from consuming them.
      if (matchKey(e) !== null) return false
      if (e.type !== 'keydown' || !e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return true
      const key = e.key.toLowerCase()
      if (key === 'c') {
        if (term.hasSelection()) {
          navigator.clipboard.writeText(term.getSelection()).catch(() => {})
        }
        return false
      }
      // ⌘V: let the native paste event through; it is routed to term.paste below.
      if (key === 'v') return false
      return true
    })

    const onPaste = (e: ClipboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const text = e.clipboardData?.getData('text/plain')
      if (text) term.paste(text)
    }
    host.addEventListener('paste', onPaste, true)

    term.onData((d) => handle?.write(d))
    term.onResize(({ cols, rows }) => handle?.resize(cols, rows))
    term.onResize(() => {
      if (runningRef.current) setLivePx(liveContentHeight(term))
    })

    spawnPty({
      cwd: callbacks.current.initialCwd,
      cols: term.cols,
      rows: term.rows,
      // After unmount (incl. our own kill in cleanup) the session's output and exit are ignored.
      onData: (b) => {
        if (!disposed) term.write(b)
      },
      onExit: () => {
        exited = true
        if (!disposed) callbacks.current.onExit()
      },
    })
      .then((h) => {
        if (disposed) {
          if (!exited) h.kill()
          return
        }
        handle = h
        handleRef.current = h
        // Resizes during the in-flight spawn were dropped; sync the current size.
        h.resize(term.cols, term.rows)
      })
      .catch((err) => {
        console.error('pty_spawn failed:', err)
        if (!disposed) term.write(`\r\n\x1b[31mНе удалось запустить оболочку: ${String(err)}\x1b[0m\r\n`)
      })

    let resizeTimer: ReturnType<typeof setTimeout> | undefined
    const ro = new ResizeObserver(() => {
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => fit.fit(), RESIZE_DEBOUNCE_MS)
    })
    ro.observe(host)
    const feed = feedRef.current
    const feedRo = new ResizeObserver(() => setFeedHeight(feed?.clientHeight ?? 0))
    if (feed) feedRo.observe(feed)

    return () => {
      disposed = true
      clearTimeout(resizeTimer)
      ro.disconnect()
      feedRo.disconnect()
      host.removeEventListener('paste', onPaste, true)
      if (!exited) handle?.kill()
      handleRef.current = null
      term.dispose()
      host.remove()
      termRef.current = null
      fitRef.current = null
    }
  }, [host])

  // Theme / font changes apply to the live terminal.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    const opts = appearance(settings)
    Object.assign(term.options, opts)
    fitRef.current?.fit()
    document.fonts
      ?.load(`${opts.fontSize}px ${opts.fontFamily}`)
      .catch(() => {})
      .then(() => {
        // Терминал закрыт или шрифт уже сменили снова — замеры сделает следующий вызов.
        if (termRef.current !== term || term.options.fontFamily !== opts.fontFamily) return
        remeasureFont(term)
        fitRef.current?.fit()
      })
  }, [settings])

  /** Куда идёт ввод: пока команда идёт или открыт alt screen — в xterm, иначе в строку ввода. */
  const focusActive = useCallback(() => {
    if (!callbacks.current.focused || useUi.getState().settingsOpen) return
    if (runningRef.current || altRef.current) termRef.current?.focus()
    else inputRef.current?.focus()
  }, [])

  // Фокус — при смене фокусной панели и после закрытия настроек.
  useEffect(() => {
    if (p.focused && !settingsOpen) focusActive()
  }, [p.focused, settingsOpen, focusActive])

  // Команда закончилась (строка ввода снова активна) — фокус в неё, если он был в панели или нигде.
  const paneRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (running || alt) return
    const active = document.activeElement
    const nothingFocused = !active || active === document.body
    if (nothingFocused || paneRef.current?.contains(active)) focusActive()
  }, [running, alt, focusActive])

  // Панель агентов исчезла (⌘J или сессии больше нет), пока фокус был в ней (элемент уже удалён) — вернуть ввод.
  const agentsShown = !!claude && !agentsHidden
  useEffect(() => {
    if (agentsShown || !p.focused) return
    const active = document.activeElement
    if (!active || active === document.body) focusActive()
  }, [agentsShown, p.focused, focusActive])

  // host перенесён в слот (блок/оверлей): размер, перерисовка, фокус.
  const onAttach = useCallback(() => {
    const term = termRef.current
    if (!term) return
    fitRef.current?.fit()
    term.refresh(0, term.rows - 1)
    if (callbacks.current.focused && !useUi.getState().settingsOpen) term.focus()
  }, [])

  // host вернулся в парковку: перенос в DOM сбросил фокус — вернуть его туда, где идёт ввод.
  const onDetach = useCallback(
    (hadFocus: boolean) => {
      const active = document.activeElement
      const nothingFocused = !active || active === document.body
      if (hadFocus || nothingFocused) focusActive()
    },
    [focusActive],
  )

  // Оболочка ещё не запущена — команду не теряем: строка ввода её сохранит.
  const onRun = useCallback((cmd: string) => {
    const h = handleRef.current
    if (!h) return false
    h.write(commandBytes(cmd))
    return true
  }, [])
  const onAsk = useCallback((text: string) => void askClaude(p.paneId, cwdRef.current, text), [p.paneId])
  const onInterrupt = useCallback(
    (empty: boolean) => {
      // Незаконченная команда (PS2): ⌃C сбрасывает строку ZLE.
      if (contRef.current) {
        handleRef.current?.write('\x03')
        return false
      }
      if (interruptClaude(p.paneId)) return true
      // Пустая строка в простое — ⌃C в оболочку, как в обычном терминале.
      if (empty) handleRef.current?.write('\x03')
      return false
    },
    [p.paneId],
  )
  const onClearFeed = useCallback(() => {
    // Идущий блок не трогаем (строка ввода в это время и так неактивна).
    setItems((it) => it.filter((x) => x.kind === 'shell' && x.running))
    claudeFrom.current = claudePrev.current.length
    setSelected(null)
  }, [])

  // Автопрокрутка: лента следует за выводом, пока пользователь у низа.
  const stickRef = useRef(true)
  const onFeedScroll = useCallback(() => {
    const f = feedRef.current
    if (f) stickRef.current = f.scrollHeight - f.scrollTop - f.clientHeight < STICK_PX
  }, [])
  useLayoutEffect(() => {
    const f = feedRef.current
    if (f && stickRef.current) f.scrollTop = f.scrollHeight
  }, [items, livePx])

  // Выбранный блок держим в видимой области.
  useEffect(() => {
    if (!selected) return
    const el = feedRef.current?.querySelector<HTMLElement>(`[data-block-id="${selected}"]`)
    el?.scrollIntoView?.({ block: 'nearest' })
  }, [selected])

  useEffect(
    () =>
      registerPaneCommands(p.paneId, (a: BlockAction) => {
        // Полноэкранная программа: лента скрыта, выбирать нечего.
        if (altRef.current) return
        if (a === 'blockCopy') {
          const b = itemsRef.current.find((it): it is ShellBlock => it.kind === 'shell' && it.id === selectedRef.current)
          if (b?.html) navigator.clipboard?.writeText(blockText(b.html)).catch(() => {})
          return
        }
        const m = moveSelection(itemsRef.current, selectedRef.current, a === 'blockPrev' ? 'up' : 'down')
        setSelected(m.id)
        // ⌘↓ с последнего блока или из строки ввода — фокус в панель агентов (если она показана).
        if (m.leave) agentsRef.current?.focus()
      }),
    [p.paneId],
  )

  const liveHeight = Math.min(hostHeight, livePx)
  const renderLive = (_b: ShellBlock) =>
    alt ? null : (
      <LiveTerminal host={host} parkRef={parkRef} mode="block" hostHeight={hostHeight} height={liveHeight} onAttach={onAttach} onDetach={onDetach} />
    )

  return (
    <div
      className="pane"
      ref={paneRef}
      data-pane-id={p.paneId}
      onFocus={() => callbacks.current.onFocus()}
      // Клик по ленте возвращает ввод туда, где он идёт: в строку ввода, а пока идёт команда — в xterm.
      onMouseUp={(e) => {
        // Кнопки ленты («Показать всё» и т. п.), само поле и выделение текста не трогаем.
        if ((e.target as Element).closest?.('button, a, input, textarea, select, .input, .agents')) return
        if (window.getSelection()?.isCollapsed ?? true) {
          if (runningRef.current || altRef.current) termRef.current?.focus()
          else inputRef.current?.focus()
        }
      }}
    >
      <Feed
        ref={feedRef}
        items={items}
        agents={claude?.state.agents}
        selectedId={selected}
        renderLive={renderLive}
        onScroll={onFeedScroll}
        park={
          // Пока xterm не показан, он стоит здесь: невидим, но сохраняет ширину текста блока (cols).
          <div className="feed-park">
            <div className="blk" ref={parkRef} />
          </div>
        }
      />
      <div className="dock">
        {claude && !agentsHidden && (
          <AgentsPanel ref={agentsRef} state={claude.state} onExit={() => inputRef.current?.focus()} />
        )}
        <InputBar
          ref={inputRef}
          disabled={running || alt}
          continuation={cont}
          completions={p.focused && !settingsOpen && settings.pathCompletions}
          cwd={() => cwdRef.current}
          home={home || null}
          onRun={onRun}
          onAsk={onAsk}
          onInterrupt={onInterrupt}
          onClearFeed={onClearFeed}
        />
      </div>
      {alt && (
        <LiveTerminal host={host} parkRef={parkRef} mode="overlay" hostHeight={hostHeight} height={0} onAttach={onAttach} onDetach={onDetach} />
      )}
    </div>
  )
}

export default TerminalPane
