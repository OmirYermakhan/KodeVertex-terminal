import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal, type ITerminalOptions } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { openUrl } from '@tauri-apps/plugin-opener'
import { useEffect, useRef } from 'react'
import { terminalLineHeight, type Settings } from '../settings/settings'
import { useSettings } from '../settings/store'
import { codeFontStack } from '../theme/fontFamily'
import { ansiFromTokens, THEMES } from '../theme/themes'
import { matchKey } from '../keys/keymap'
import { parseOsc7 } from './osc'
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

export function TerminalPane(p: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const callbacks = useRef(p)
  useEffect(() => {
    callbacks.current = p
  })

  const settings = useSettings((st) => st.settings)

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

    term.parser.registerOscHandler(7, (data) => {
      const cwd = parseOsc7(data)
      if (cwd) callbacks.current.onCwd(cwd)
      return true
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

    spawnPty({
      cwd: callbacks.current.initialCwd,
      cols: term.cols,
      rows: term.rows,
      // After unmount (incl. our own kill in cleanup) the session's output and exit are ignored.
      onData: (b) => {
        if (!disposed) term.write(b)
      },
      onExit: () => {
        if (!disposed) callbacks.current.onExit()
      },
    })
      .then((h) => {
        if (disposed) {
          h.kill()
          return
        }
        handle = h
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
      handle?.kill()
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
      .then(() => fitRef.current?.fit())
  }, [settings])

  useEffect(() => {
    if (p.focused) termRef.current?.focus()
  }, [p.focused])

  return (
    <div
      data-pane-id={p.paneId}
      onFocus={() => callbacks.current.onFocus()}
      style={{ height: '100%', boxSizing: 'border-box', padding: '10px 12px', background: 'var(--bg)' }}
    >
      <div ref={hostRef} style={{ height: '100%', width: '100%' }} />
    </div>
  )
}

export default TerminalPane
