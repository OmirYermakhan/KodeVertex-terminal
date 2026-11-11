import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal, type ITerminalOptions } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { openUrl } from '@tauri-apps/plugin-opener'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { terminalLineHeight, type Settings } from '../settings/settings'
import { useSettings } from '../settings/store'
import { useUi } from '../ui/uiStore'
import { codeFontStack } from '../theme/fontFamily'
import { ansiFromTokens, THEMES } from '../theme/themes'
import { matchKey } from '../keys/keymap'
import { parseOsc7 } from './osc'
import { parseOsc6973 } from '../completion/completion'
import { useCompletion } from '../completion/useCompletion'
import { CompletionPopup, LIST_WIDTH, PREVIEW_WIDTH, popupHeight } from '../completion/CompletionPopup'
import { useHome } from '../status/useGitInfo'
import { spawnPty, type PtyHandle } from './ptyClient'

const RESIZE_DEBOUNCE_MS = 50

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

/** Над строкой курсора, а если сверху не помещается — под ней; превью — если хватает ширины. */
function popupPlacement(term: Terminal | null, host: HTMLElement | null, count: number) {
  if (!term || !host) return null
  const screen = term.element?.querySelector<HTMLElement>('.xterm-screen')
  const width = screen?.clientWidth || host.clientWidth
  const height = screen?.clientHeight || host.clientHeight
  const cellW = term.cols > 0 ? width / term.cols : 0
  const cellH = term.rows > 0 ? height / term.rows : 0
  const { cursorX = 0, cursorY = 0, baseY = 0, viewportY = 0 } = term.buffer?.active ?? {}
  // Строка курсора относительно видимой области; прокрутили вверх — попап не показываем.
  const row = baseY + cursorY - viewportY
  if (row < 0 || row >= term.rows) return null
  const rowTop = row * cellH
  const h = popupHeight(count)
  const y = rowTop - h >= 0 ? rowTop - h : rowTop + cellH
  const avail = host.clientWidth || width
  const x = Math.max(0, Math.min(cursorX * cellW, avail - LIST_WIDTH))
  // В jsdom размеров нет — превью не прячем.
  const previewFits = avail === 0 || x + LIST_WIDTH + PREVIEW_WIDTH <= avail
  return { x, y, previewFits }
}

export function TerminalPane(p: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const callbacks = useRef(p)
  useEffect(() => {
    callbacks.current = p
  })

  const [layoutTick, setLayoutTick] = useState(0)
  const handleRef = useRef<PtyHandle | null>(null)
  // cwd панели для подсказок путей: initialCwd, затем OSC 7.
  const cwdRef = useRef(p.initialCwd)
  const home = useHome()
  const completion = useCompletion({
    cwd: () => cwdRef.current,
    home: home || null,
    write: (s) => handleRef.current?.write(s),
  })
  const completionRef = useRef(completion)
  useEffect(() => {
    completionRef.current = completion
  })

  const settings = useSettings((st) => st.settings)
  const settingsOpen = useUi((st) => st.settingsOpen)

  // Create xterm + PTY once per pane.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      ...appearance(useSettings.getState().settings),
      allowProposedApi: true,
      macOptionIsMeta: true,
      scrollback: 10000,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
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

    term.parser.registerOscHandler(6973, (data) => {
      const report = parseOsc6973(data)
      // Фоновая панель или открытые настройки — подсказки не показываем.
      const active = callbacks.current.focused && !useUi.getState().settingsOpen
      if (report && (report === 'end' || active)) completionRef.current.onReport(report)
      return true
    })

    term.attachCustomKeyEventHandler((e) => {
      // Открытый попап забирает свои клавиши до xterm; preventDefault гасит keypress и уход фокуса по Tab.
      if (completionRef.current.onKey(e)) {
        e.preventDefault()
        return false
      }
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
      // Вставка меняет строку мимо попапа — его ctx устарел.
      completionRef.current.onPaste()
      const text = e.clipboardData?.getData('text/plain')
      if (text) term.paste(text)
    }
    host.addEventListener('paste', onPaste, true)

    term.onData((d) => handle?.write(d))
    term.onResize(({ cols, rows }) => handle?.resize(cols, rows))
    // Пересчитать позицию попапа при прокрутке и изменении размера.
    term.onScroll(() => setLayoutTick((n) => n + 1))
    term.onResize(() => setLayoutTick((n) => n + 1))

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

    return () => {
      disposed = true
      clearTimeout(resizeTimer)
      ro.disconnect()
      host.removeEventListener('paste', onPaste, true)
      if (!exited) handle?.kill()
      handleRef.current = null
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [])

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

  // Фокус в терминал — при смене фокусной панели и после закрытия настроек.
  useEffect(() => {
    if (p.focused && !settingsOpen) termRef.current?.focus()
    else completionRef.current.close()
  }, [p.focused, settingsOpen])

  // Позиция попапа считается по курсору xterm после того, как пришёл новый список.
  const [popup, setPopup] = useState<ReturnType<typeof popupPlacement>>(null)
  const { open, items } = completion.state
  useLayoutEffect(() => {
    const placement = open ? popupPlacement(termRef.current, hostRef.current, items.length) : null
    setPopup(placement)
    // Курсор вне видимой области: невидимый попап не должен съедать клавиши.
    if (open && !placement) completionRef.current.close()
  }, [open, items, layoutTick])

  return (
    <div
      data-pane-id={p.paneId}
      onFocus={() => callbacks.current.onFocus()}
      style={{ height: '100%', boxSizing: 'border-box', padding: '10px 12px', background: 'var(--bg)' }}
    >
      <div style={{ position: 'relative', height: '100%', width: '100%' }}>
        <div ref={hostRef} style={{ height: '100%', width: '100%' }} />
        {popup && open && (
          <CompletionPopup
            state={completion.state}
            x={popup.x}
            y={popup.y}
            previewFits={popup.previewFits}
            onPick={completion.pick}
          />
        )}
      </div>
    </div>
  )
}

export default TerminalPane
