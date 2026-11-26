import { FitAddon } from '@xterm/addon-fit'
import { ReaderView } from '../claude/reader/ReaderView'
import { agentSignature } from '../claude/cards/AssistantCard'
import { ErrorBoundary } from '../diag/ErrorBoundary'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal, type ITerminalOptions } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { openUrl } from '@tauri-apps/plugin-opener'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { terminalLineHeight, type Settings } from '../settings/settings'
import { useSettings } from '../settings/store'
import { useUi } from '../ui/uiStore'
import { codeFontStack } from '../theme/fontFamily'
import { ansiFromTokens, THEMES } from '../theme/themes'
import { matchKey } from '../keys/keymap'
import { isLocalHost, parseOsc7Url, unmark } from './osc'
import { useHome } from '../status/useGitInfo'
import { attachPty, detachPty, killPty, spawnPty, type PtyHandle } from './ptyClient'
import { dropLiveSource, isMoving, reofferLive, setLiveSource, takeLive, type LiveSource } from '../windows/livePanes'
import { notifyCommandEnd } from '../notify/notify'
import { useProject } from '../project/store'
import { applyShell, claudeIndex, claudeItemId, commandBytes, failurePrompt, firstUnfinished, moveSelection, parseOsc133, syncClaude, type FeedItem, type ShellBlock } from '../feed/feed'
import type { FeedClaudeItem } from '../claude/reducer'
import { editClaude, dismissQueueHint, dismissSuggestion, feedCleared, recallQueued, removeQueued, sendQueued, sendQueuedNow, type QueuedMessage, answerPermission, answerQuestion, askClaude, chooseModel, questionStep, submitQuestion, claudeCwdKnown, claudeOpen, clearClaude, enterClaude, exitClaude, interruptClaude, listSessions, resumeClaude, stopClaude, useClaudeSessions, type ModelChoice, answerTrust, useClaudeTrust } from '../claude/sessionStore'
import type { SessionInfo } from '../claude/resume'
import { aliasOf } from '../claude/models'
import { backgroundWait, canEdit, editInfo, lastEditable, pendingPrompt, thinkingSince, type PermissionDecision } from '../claude/reducer'
import { EditChip } from '../claude/EditChip'
import { docOf } from '../attach/doc'
import { PermissionPrompt } from '../claude/PermissionPrompt'
import { QuestionPrompt } from '../claude/QuestionPrompt'
import { LinkPrompt, TrustPrompt } from '../claude/ConfirmPrompt'
import { answerLink, askOpenLink, useLinkAsk } from '../feed/linkAsk'
import { dropPaneFeed, restoredPane, scheduleSave, setPaneFeed } from '../persist/session'
import { InputBar, LOGIN_OFFER, type InputBarHandle, type InputSnapshot } from '../input/InputBar'
import { QueuePanel, type QueuePanelHandle } from '../claude/QueuePanel'
import { BtwCard } from '../claude/BtwCard'
import { askBtw, closeBtw, useBtw } from '../claude/btw'
import { Collapse } from '../ui/motion'
import { AgentsPanel, type AgentsPanelHandle } from '../claude/AgentsPanel'
import { blockText, blockTextOf, cleanSerializedHtml } from '../feed/blockHtml'
import { pushHistory } from '../input/history'
import { Feed } from '../feed/FeedView'
import { LiveTerminal } from '../feed/LiveTerminal'
import { registerPaneCommands, type PaneAction } from '../feed/paneCommands'
import { FindBar, type FindBarHandle } from '../feed/FindBar'
import { isAuthLogin, parseClaudeCommand } from '../input/claudeCommand'
import { registerPaneRunner, takePending, usePaneRunning } from '../launch/runner'
import { feedAttachment, quoteAttachment } from '../attach/fromFeed'
import { QuoteReply, quoteSelection, type QuoteSel } from '../claude/QuoteReply'
import { DROP_TITLE, DROP_TITLE_SHELL, DROP_TITLE_SHELL_MANY, dropSubline, registerDropTarget, setAttachCount, useDrop } from '../attach/dragDrop'
import { DROP_PATH, Token } from '../attach/tokenView'
import type { Attachment } from '../attach/types'
import { PreviewContext, usePreview } from '../attach/preview/usePreview'
import { PreviewLayer } from '../attach/preview/PreviewLayer'
import { openPath } from '../attach/preview/api'
import type { PreviewAction } from '../attach/preview/actions'
import type { AtFeed, AtMessage } from '../attach/atSearch'

const RESIZE_DEBOUNCE_MS = 50
/** Живой терминал внутри блока — не выше этой доли ленты, дальше скролл внутри xterm. */
const LIVE_MAX_SHARE = 0.6
const LIVE_MIN_HEIGHT = 80
/** «У низа» ленты: автопрокрутка продолжается. */
const STICK_PX = 24
/** Сдвиг указателя, после которого начинается перетаскивание блока или ответа в строку ввода. */
const DRAG_MIN_PX = 4
/** После ↵ строка ввода ждёт ответа оболочки (133;C или 133;A) не дольше этого. */
const AWAIT_SHELL_MS = 2000
/** Перенос вкладки: дольше этого снимок экрана не ждёт разбора уже полученного вывода. */
const CAPTURE_WAIT_MS = 500

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
const NO_QUEUE: readonly QueuedMessage[] = []

/** Число строк вывода: индекс последней непустой строки активного буфера (до below) + 1. */
function contentLines(term: Terminal, below = Infinity): number {
  const buf = term.buffer.active
  for (let i = Math.min(buf.length, below) - 1; i >= 0; i--) {
    if (buf.getLine(i)?.translateToString(true).trim()) return i + 1
  }
  return 0
}

/** Конец команды: вывод из буфера xterm → HTML блока (только из SerializeAddon). */
function freeze(term: Terminal, ser: SerializeAddon, below = Infinity): { html: string; lines: number } {
  const lines = contentLines(term, below)
  if (lines === 0) return { html: '', lines: 0 }
  const raw = ser.serializeAsHTML({ includeGlobalBackground: false, range: { startLine: 0, endLine: lines - 1, startCol: 0 } })
  return { html: cleanSerializedHtml(raw), lines }
}

/**
 * Вывод после строки RAW_NOTE (её xterm мог перенести на несколько строк) — HTML блока; без строки
 * RAW_NOTE — весь буфер.
 */
function freezeAfterNote(term: Terminal, ser: SerializeAddon): { html: string; lines: number } {
  const buf = term.buffer.active
  const text = (i: number) => buf.getLine(i)?.translateToString(true) ?? ''
  let from = 0
  for (let i = 0; i < buf.length; i++) {
    if (!text(i).includes(RAW_NOTE_HEAD)) continue
    let j = i
    while (j < buf.length - 1 && !text(j).includes(']')) j++
    from = j + 1
    break
  }
  const end = contentLines(term)
  if (end <= from) return { html: '', lines: 0 }
  const raw = ser.serializeAsHTML({ includeGlobalBackground: false, range: { startLine: from, endLine: end - 1, startCol: 0 } })
  return { html: cleanSerializedHtml(raw), lines: end - from }
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

/** Абсолютная строка курсора в активном буфере. */
function cursorRow(term: Terminal): number {
  const buf = term.buffer.active
  return buf.baseY + buf.cursorY
}

/** Пока буфер xterm разбирает больше стольких байт — чтение PTY приостанавливается… */
export const WRITE_HIGH = 1 << 20
/** …и продолжается, когда разобрано до стольких. */
export const WRITE_LOW = 256 << 10

/**
 * Команда заменяет оболочку (`exec zsh`, `exec bash -l`, `FOO=1 exec zsh`): новая оболочка без нашей
 * интеграции (метка сессии не наследуется — ZDOTDIR в окружение не кладём), маркеров больше не будет.
 * `exec` без команды (только перенаправления: `exec >log 2>&1`, `exec {fd}>file`) оболочку не заменяет.
 */
export function replacesShell(command: string): boolean {
  // Присваивания перед exec (`FOO=1 BAR="a b" exec zsh`) — окружение новой оболочки.
  const m = /^\s*(?:[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|[^\s"']*)\s+)*(?:builtin\s+)?exec\b(.*)$/s.exec(command)
  if (!m) return false
  // Цепочки и подоболочки (`exec x; y`, `a && exec b`) не разбираем: только простая команда.
  if (/[;&|\n()]/.test(m[1])) return false
  const words = m[1].trim().split(/\s+/).filter(Boolean)
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    // Перенаправление: `>f`, `2>&1`, `<f`, `> f` (имя файла — следующим словом), `{fd}>f` — номер
    // дескриптора в переменную, `&>f`.
    if (/^(?:\d*|\{[A-Za-z_]\w*\}|&)[<>]/.test(w)) {
      if (/^(?:\d*|\{[A-Za-z_]\w*\}|&)(?:[<>]|>>|<<|>&|<&|>\||<>)$/.test(w)) i++
      continue
    }
    if (w === '-a') {
      i++
      continue
    }
    if (/^-[cl]+$/.test(w) || w === '--') continue
    return true
  }
  return false
}

/** Строка в xterm, когда интеграция оболочки потеряна (`exec`): дальше — обычный терминал. */
const RAW_NOTE_HEAD = '[оболочка заменена командой exec'
export const RAW_NOTE = `\r\n\x1b[2m${RAW_NOTE_HEAD} — блоки недоступны, терминал работает как обычный]\x1b[0m\r\n`

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
  const queueRef = useRef<QueuePanelHandle>(null)
  // cwd панели (подсказки путей, Claude-сессия): initialCwd, затем OSC 7.
  const cwdRef = useRef(p.initialCwd)
  /** Стабильные ссылки для memo-детей (строка ввода, очередь): иначе — новые на каждый рендер. */
  const getCwd = useCallback(() => cwdRef.current, [])
  const focusInput = useCallback(() => inputRef.current?.focus(), [])
  const home = useHome()

  const settings = useSettings((st) => st.settings)
  const settingsOpen = useUi((st) => st.settingsOpen)
  const agentsHidden = useUi((st) => st.agentsHidden)
  const agentRequest = useUi((st) => (st.agentRequest?.paneId === p.paneId ? st.agentRequest : null))
  // Клик по тосту: выбрать агента в панели агентов (панель появляется на следующем кадре, если была скрыта).
  useEffect(() => {
    if (!agentRequest) return
    const t = setTimeout(() => {
      agentsRef.current?.select(agentRequest.agentId)
      useUi.getState().clearAgentRequest()
    }, 0)
    return () => clearTimeout(t)
  }, [agentRequest])

  // Лента, восстановленная после перезапуска приложения (до монтирования панели).
  const [restored] = useState(() => restoredPane(p.paneId))
  const [items, setItems] = useState<FeedItem[]>(() => (restored ? [...restored.items] : []))
  const itemsRef = useRef(items)
  useEffect(() => {
    itemsRef.current = items
  })
  const [selected, setSelected] = useState<string | null>(null)
  /** Ответ, открытый в режиме чтения (id элемента ленты). */
  const [readerId, setReaderId] = useState<string | null>(null)
  const readerIdRef = useRef(readerId)
  useLayoutEffect(() => {
    readerIdRef.current = readerId
  })
  const selectedRef = useRef(selected)
  useEffect(() => {
    selectedRef.current = selected
  })
  const [alt, setAlt] = useState(false)
  const altRef = useRef(alt)
  /** Команда заходила в alt screen (vim, less…) — не «долгая команда» для уведомления. */
  const altUsedRef = useRef(false)
  /**
   * Интеграция оболочки потеряна (`exec zsh`): маркеров больше не будет — панель как при alt screen,
   * xterm поверх ленты с вводом в него. Возвращается маркером нашей оболочки (exec не удался).
   */
  const rawRef = useRef(false)
  /** Строка курсора xterm в момент отправки команды: с неё ZLE рисует эхо, выше — вывод оболочки до него. */
  const echoRowRef = useRef<number | null>(null)
  /** Высота строки живого xterm, px (0 — перемерить: смена размера или шрифта). */
  const cellRef = useRef(0)
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
  // ↵ отправлен, оболочка ещё не начала команду (нет C) и не вернула приглашение (нет A):
  // второй ↵ ушёл бы в stdin первой команды — строка ввода пока неактивна.
  const [awaiting, setAwaiting] = useState(false)
  const awaitingRef = useRef(false)
  useEffect(() => {
    awaitingRef.current = awaiting
  })
  // Быстрый вход: команда ждёт первого приглашения оболочки (и готового PTY).
  const promptSeenRef = useRef(false)
  const runPendingRef = useRef<() => void>(() => {})
  useEffect(() => {
    usePaneRunning.getState().set(p.paneId, running)
  }, [p.paneId, running])
  useEffect(() => {
    const paneId = p.paneId
    return () => usePaneRunning.getState().set(paneId, false)
  }, [p.paneId])
  const awaitTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const setAwaitingShell = useCallback((v: boolean) => {
    clearTimeout(awaitTimer.current)
    if (v) awaitTimer.current = setTimeout(() => setAwaiting(false), AWAIT_SHELL_MS)
    setAwaiting(v)
  }, [])
  useEffect(() => () => clearTimeout(awaitTimer.current), [])
  /** Последняя отправленная строка — ждёт 133;I (ZLE приняла строку). */
  const sentRef = useRef<string | null>(null)
  /** Строка принята ZLE (133;I), но команда не запустилась (ещё нет C): её вывод — отдельный блок. */
  const acceptedRef = useRef<string | null>(null)

  // Claude-сессия панели (стор по paneId): её элементы — в той же ленте, по времени появления.
  const claude = useClaudeSessions((st) => st.sessions[p.paneId])
  const claudeItems = claude?.state.items ?? NO_CLAUDE_ITEMS
  // Восстановленная лента уже содержит карточки сессии: синхронизация — от них.
  const claudePrev = useRef<readonly FeedClaudeItem[]>(restored ? claudeItems : NO_CLAUDE_ITEMS)
  // ⌃L: элементы Claude с индексом меньше этого в ленте больше не показываются.
  const claudeFrom = useRef(restored?.claudeFrom ?? 0)
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
  // Сессия окна между запусками: лента панели читается в момент снимка, изменения — автосохранение.
  useEffect(() => {
    const paneId = p.paneId
    const feed = () => ({ items: itemsRef.current, claudeFrom: claudeFrom.current, claudeMode: inputRef.current?.claudeMode() ?? false })
    setPaneFeed(paneId, feed)
    return () => dropPaneFeed(paneId, feed)
  }, [p.paneId])
  useEffect(() => scheduleSave(), [items])

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
      // Ссылки OSC 8: без обработчика xterm открыл бы их confirm() и window.open в самом WebView.
      // Открываем, как и найденные WebLinksAddon, во внешнем браузере — только http(s). Текст такой
      // ссылки задаёт программа, адреса не видно: сначала вопрос с хостом над строкой ввода.
      linkHandler: {
        activate: (_e, uri) => {
          if (/^https?:\/\//i.test(uri)) askOpenLink(callbacks.current.paneId, uri)
        },
      },
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
    // Вкладка принята из другого окна: PTY панели живой — подключаемся к нему, а не запускаем новый.
    const paneId = callbacks.current.paneId
    const adopted = takeLive(paneId)
    if (adopted) term.resize(adopted.cols, adopted.rows)
    else fit.fit()
    termRef.current = term
    fitRef.current = fit

    let handle: PtyHandle | null = null
    let disposed = false
    // Обратное давление: сколько байт отдано xterm и ещё не разобрано. Без него `yes` или `cat`
    // большого файла копят в xterm десятки мегабайт (xterm 6 бросает исключение, вывод и маркер 133;D
    // теряются — блок навсегда «идёт»). Выше WRITE_HIGH чтение PTY приостанавливается.
    let pty: PtyHandle | null = null
    let unparsed = 0
    let paused = false
    const feedTerm = (b: Uint8Array) => {
      unparsed += b.length
      if (!paused && unparsed > WRITE_HIGH && pty) {
        paused = true
        pty.pause?.()
      }
      term.write(b, () => {
        unparsed -= b.length
        if (paused && unparsed < WRITE_LOW && !disposed) {
          paused = false
          pty?.resume?.()
        }
      })
    }

    // Высота живого блока: высота строки — из кэша (перемер — только после смены размера и шрифта),
    // состояние — не чаще кадра и только при изменении.
    let livePxNow = -1
    let liveFrame = 0
    const liveHeight = () => {
      if (!cellRef.current) {
        const screen = term.element?.querySelector<HTMLElement>('.xterm-screen')
        // Кэшируем только замер по DOM; запасной расчёт по настройкам — каждый раз.
        if (screen && term.rows > 0 && screen.clientHeight > 0) cellRef.current = screen.clientHeight / term.rows
        else return Math.ceil(usedRows(term) * cellHeight(term))
      }
      return Math.ceil(usedRows(term) * cellRef.current)
    }
    const syncLive = () => {
      liveFrame = 0
      if (!runningRef.current || disposed) return
      const px = liveHeight()
      if (px === livePxNow) return
      livePxNow = px
      setLivePx(px)
    }
    const scheduleLive = () => {
      if (!liveFrame) liveFrame = requestAnimationFrame(syncLive)
    }
    /** Полноэкранного режима больше нет: alt screen вышел, а потерянная интеграция держит оверлей. */
    const altOff = () => setAlt(rawRef.current || term.buffer.active.type === 'alternate')
    // Оболочка уже завершилась сама: сессии на стороне Rust больше нет, kill не нужен.
    let exited = false

    // Метка маркеров сессии (из pty_spawn): OSC 133/7 без неё напечатал не наш zsh — `cat` файла,
    // программа или удалённая оболочка; такие подделали бы блоки, код возврата и каталог.
    let mark: string | null = adopted?.mark ?? null
    // Хост первого OSC 7 нашей оболочки (precmd до любой команды) — этот компьютер.
    let localHost: string | null = adopted?.localHost ?? null
    term.parser.registerOscHandler(7, (data) => {
      const payload = unmark(data, mark)
      const url = payload === null ? null : parseOsc7Url(payload)
      // Каталог — только от нашей оболочки в простое: не от `cat` файла, ssh или программы во время команды.
      if (!url || runningRef.current || !isLocalHost(url.host, localHost)) return true
      if (localHost === null && url.host && url.host.toLowerCase() !== 'localhost') localHost = url.host
      cwdRef.current = url.path
      callbacks.current.onCwd(url.path)
      return true
    })

    const frozen = () => (term.buffer.active.type === 'alternate' ? { html: '', lines: 0 } : freeze(term, serializer))
    /** Вывод вне пары C…D (ошибка разбора и т. п.) — отдельным блоком. */
    const flushStray = (command: string, below = Infinity) => {
      const { html, lines } = term.buffer.active.type === 'alternate' ? { html: '', lines: 0 } : freeze(term, serializer, below)
      if (lines > 0) setItems((it) => applyShell(it, { t: 'stray', command, cwd: cwdRef.current ?? '', at: Date.now(), html, lines }))
      return lines > 0
    }
    /**
     * Маркер нашей оболочки пришёл, а xterm ещё в alt screen (полноэкранную программу убили, она
     * не вышла из него): иначе оверлей закрыл бы панель, а ввод остался выключенным. reset — как и
     * эхо строки, синхронно, до остального куска данных (оболочка ещё не рисовала приглашение).
     */
    const leaveStaleAlt = () => {
      if (term.buffer.active.type !== 'alternate') return
      term.reset()
      altOff()
    }
    /** Команда, после которой интеграция потеряна (`exec …`). */
    let rawCommand = adopted?.rawCommand ?? ''
    /**
     * Маркер нашей оболочки: интеграция на месте (exec не удался) — обычный режим блоков. Что оболочка
     * напечатала после exec (`zsh: command not found`), — в блок этой команды, а не под reset.
     */
    const integrationBack = (exitCode: number | null) => {
      if (!rawRef.current) return
      rawRef.current = false
      if (term.buffer.active.type !== 'alternate') {
        const { html, lines } = freezeAfterNote(term, serializer)
        setItems((it) => applyShell(it, { t: 'late', command: rawCommand, cwd: cwdRef.current ?? '', exitCode, at: Date.now(), html, lines }))
      }
      term.reset()
      altOff()
    }
    const endBlock = (exitCode: number | null) => {
      const at = Date.now()
      runningRef.current = false
      setRunning(false)
      // Конец пришёл при активном alt screen (программа не вышла из него) — его содержимое не замораживаем.
      const { html, lines } = frozen()
      const cur = itemsRef.current.find((x): x is ShellBlock => x.kind === 'shell' && x.running)
      if (cur && exitCode !== null) {
        notifyCommandEnd(callbacks.current.paneId, cur.command, Math.max(0, at - cur.startedAt), exitCode, altUsedRef.current)
        // Вход удался (`/login` → `claude auth login`): обратно в Claude — одним ↵, без набора `claude`.
        if (exitCode === 0 && isAuthLogin(cur.command)) inputRef.current?.offerClaude(LOGIN_OFFER)
      }
      setItems((it) => applyShell(it, { t: 'end', exitCode, at, html, lines }))
      // Вывод заморожен: xterm чист к следующему приглашению — вывод оболочки до эха строки (direnv,
      // «[1] + done») станет отдельным блоком, а не повтором этого. Оболочка ещё в precmd, ZLE не рисовал.
      // reset выводит и из alt screen, если программа не вышла из него сама.
      term.reset()
      altOff()
      // Команда могла поменять файлы — панель проекта обновляется (из любой панели).
      useProject.getState().refresh()
    }

    // Блоки: zsh сообщает начало (C) и конец (D) команды.
    term.parser.registerOscHandler(133, (data) => {
      const payload = unmark(data, mark)
      const ev = payload === null ? null : parseOsc133(payload)
      if (!ev) return true
      if (ev.t === 'accepted') {
        // Во время команды (vared и т. п.) — это не наша строка ввода.
        if (runningRef.current) return true
        // Вывод оболочки до эха строки (выше строки, с которой ZLE начал эхо) — отдельным блоком.
        const echoRow = echoRowRef.current
        echoRowRef.current = null
        if (echoRow !== null && echoRow > 0) flushStray('', echoRow)
        // Эхо принятой строки стираем: дальше в xterm только то, что напечатает оболочка.
        term.reset()
        acceptedRef.current = sentRef.current
        sentRef.current = null
        return true
      }
      if (ev.t === 'continue') {
        setContinuation(true)
        setAwaitingShell(false)
        return true
      }
      // Приглашение во время команды (ssh на хост со своей интеграцией) — не наше: блок не трогаем.
      if (ev.t === 'prompt' && runningRef.current) return true
      setContinuation(false)
      setAwaitingShell(false)
      integrationBack(ev.t === 'end' ? ev.exitCode : null)
      if (ev.t === 'prompt') {
        leaveStaleAlt()
        // Строка принята, но команда не запустилась (ошибка разбора): её вывод — блоком,
        // и xterm чист — следующее эхо не повторит его.
        if (acceptedRef.current !== null && flushStray(acceptedRef.current)) term.reset()
        acceptedRef.current = null
        promptSeenRef.current = true
        runPendingRef.current()
        return true
      }
      const at = Date.now()
      if (ev.t === 'start') {
        acceptedRef.current = null
        // Стираем эхо набранной строки ZLE — в живом терминале только вывод команды.
        term.reset()
        // Синхронно: вывод из того же куска данных (onWriteParsed) уже должен считаться живым.
        runningRef.current = true
        altUsedRef.current = false
        echoRowRef.current = null
        setRunning(true)
        // Синхронно: живой блок сразу нужной высоты, дальше — по кадрам.
        livePxNow = liveHeight()
        setLivePx(livePxNow)
        setItems((it) => applyShell(it, { t: 'start', command: ev.command, cwd: cwdRef.current ?? '', at }))
        if (replacesShell(ev.command)) {
          // `exec zsh`: новая оболочка без маркеров — блок не закончится никогда. Закрываем его сразу
          // и переходим в обычный терминал (xterm поверх ленты), чтобы не запереть ввод.
          rawRef.current = true
          rawCommand = ev.command
          endBlock(null)
          term.write(RAW_NOTE)
        }
      } else {
        endBlock(ev.exitCode)
      }
      return true
    })

    // Полноэкранные программы (vim, htop, less) — xterm поверх всей панели.
    term.buffer.onBufferChange((b) => {
      if (b.type === 'alternate') altUsedRef.current = true
      setAlt(rawRef.current || b.type === 'alternate')
    })
    term.onWriteParsed(() => {
      if (runningRef.current) scheduleLive()
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
      cellRef.current = 0
      if (runningRef.current) scheduleLive()
    })

    // Принятый PTY, пока pty_attach не ответил: повторный перенос отсоединит именно его (pty_detach
    // встанет в очередь за pty_attach), а не запустит в приёмнике новую оболочку.
    let attaching: string | null = null
    const ptyOutput = (b: Uint8Array) => {
      if (!disposed) feedTerm(b)
    }
    const ptyExit = () => {
      exited = true
      if (!disposed) callbacks.current.onExit()
    }
    // Живое состояние для переноса вкладки в другое окно (снимается после pty_detach).
    const live: LiveSource = {
      ptyId: () => (exited ? null : (handle?.id ?? attaching)),
      capture: async () => {
        const id = handle?.id ?? attaching
        if (id === null || exited || disposed || mark === null) return null
        // Уже полученный вывод — разобрать до снимка (не дольше CAPTURE_WAIT_MS).
        await new Promise<void>((r) => {
          const t = setTimeout(r, CAPTURE_WAIT_MS)
          term.write('', () => {
            clearTimeout(t)
            r()
          })
        })
        if (disposed) return null
        return {
          ptyId: id,
          mark,
          localHost,
          cwd: cwdRef.current ?? null,
          running: runningRef.current,
          raw: rawRef.current,
          rawCommand,
          promptSeen: promptSeenRef.current,
          alt: term.buffer.active.type === 'alternate',
          altUsed: altUsedRef.current,
          cont: contRef.current,
          sent: sentRef.current,
          accepted: acceptedRef.current,
          echoRow: echoRowRef.current,
          cols: term.cols,
          rows: term.rows,
          xterm: serializer.serialize(),
        }
      },
      reattach: async () => {
        const id = handle?.id ?? attaching
        if (id === null || exited || disposed || mark === null) return
        const h = await attachPty({ id, mark, onData: ptyOutput, onExit: ptyExit })
        if (disposed) return
        attaching = null
        pty = h
        ready(h)
        h.resume?.()
      },
    }
    setLiveSource(paneId, live)

    const ready = (h: PtyHandle) => {
      handle = h
      handleRef.current = h
      // Resizes during the in-flight spawn were dropped; sync the current size.
      h.resize(term.cols, term.rows)
      if (promptSeenRef.current) runPendingRef.current()
    }

    if (adopted) {
      // Состояние оболочки — как было в окне-источнике: идущая команда остаётся идущей.
      if (adopted.cwd) cwdRef.current = adopted.cwd
      rawRef.current = adopted.raw
      promptSeenRef.current = adopted.promptSeen
      runningRef.current = adopted.running
      altUsedRef.current = adopted.altUsed
      sentRef.current = adopted.sent
      acceptedRef.current = adopted.accepted
      echoRowRef.current = adopted.echoRow
      contRef.current = adopted.cont
      setCont(adopted.cont)
      setRunning(adopted.running)
      setAlt(adopted.raw || adopted.alt)
      // Экран и scrollback — в размере источника, затем подгонка под это окно (xterm перенесёт строки).
      term.write(adopted.xterm, () => {
        if (disposed) return
        altUsedRef.current = adopted.altUsed
        fit.fit()
        if (runningRef.current) scheduleLive()
      })
      attaching = adopted.ptyId
      attachPty({ id: adopted.ptyId, mark: adopted.mark, onData: ptyOutput, onExit: ptyExit })
        .then((h) => {
          // Размонтирована раньше: PTY уже отдан обратно (см. очистку).
          if (disposed) return
          attaching = null
          pty = h
          ready(h)
          // Источник мог приостановить чтение (обратное давление) — здесь неразобранного нет.
          h.resume?.()
        })
        .catch((err) => {
          attaching = null
          console.error('pty_attach failed:', err)
          if (!disposed) term.write(`\r\n\x1b[31mНе удалось подключить оболочку в этом окне: ${String(err)}\x1b[0m\r\n`)
        })
    } else {
      spawnPty({
        cwd: callbacks.current.initialCwd,
        cols: term.cols,
        rows: term.rows,
        // After unmount (incl. our own kill in cleanup) the session's output and exit are ignored.
        onData: (b) => {
          if (!disposed) feedTerm(b)
        },
        onExit: () => {
          exited = true
          if (!disposed) callbacks.current.onExit()
        },
        // До первого вывода: маркеры первого приглашения уже сверяются с меткой.
        onSpawn: (h) => {
          mark = h.mark
          pty = h
        },
      })
        .then((h) => {
          if (disposed) {
            if (!exited) h.kill()
            return
          }
          ready(h)
        })
        .catch((err) => {
          console.error('pty_spawn failed:', err)
          if (!disposed) term.write(`\r\n\x1b[31mНе удалось запустить оболочку: ${String(err)}\x1b[0m\r\n`)
        })
    }

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
      cancelAnimationFrame(liveFrame)
      clearTimeout(resizeTimer)
      ro.disconnect()
      feedRo.disconnect()
      host.removeEventListener('paste', onPaste, true)
      dropLiveSource(paneId, live)
      // Панель уезжает в другое окно: PTY уже отсоединён, его подключит окно-приёмник.
      if (isMoving(paneId)) {
        // ничего не убиваем
      } else if (adopted && !exited) {
        // Принятая панель: StrictMode перемонтирует её и заберёт PTY снова, иначе через такт он убит.
        const id = adopted.ptyId
        void detachPty(id).catch(() => {})
        reofferLive(paneId, adopted, () => killPty(id))
      } else if (!exited) handle?.kill()
      handleRef.current = null
      term.dispose()
      host.remove()
      termRef.current = null
      fitRef.current = null
    }
  }, [host, setAwaitingShell])

  // Theme / font changes apply to the live terminal — только они: переключатель любой другой
  // настройки не должен перемерять шрифт и чистить атлас.
  const { codeFont, codeSize, lineHeight, theme } = settings
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    const opts = appearance(useSettings.getState().settings)
    cellRef.current = 0
    Object.assign(term.options, opts)
    fitRef.current?.fit()
    document.fonts
      ?.load(`${opts.fontSize}px ${opts.fontFamily}`)
      .catch(() => {})
      .then(() => {
        // Терминал закрыт или шрифт уже сменили снова — замеры сделает следующий вызов.
        if (termRef.current !== term || term.options.fontFamily !== opts.fontFamily) return
        remeasureFont(term)
        cellRef.current = 0
        fitRef.current?.fit()
      })
  }, [codeFont, codeSize, lineHeight, theme])

  /** Куда идёт ввод: пока команда идёт или открыт alt screen — в xterm, иначе в строку ввода. */
  const focusActive = useCallback(() => {
    // Открыты настройки или палитра ⌘P — фокус у них (палитра вернёт его сама).
    const ui = useUi.getState()
    if (!callbacks.current.focused || ui.settingsOpen || ui.paletteOpen) return
    if (runningRef.current || altRef.current) termRef.current?.focus()
    else inputRef.current?.focus()
  }, [])

  /** Кнопка мыши нажата в панели: фокус не переносим до отпускания (иначе сорвётся выделение текста). */
  const pointerDown = useRef(false)
  // Фокус — при смене фокусной панели и после закрытия настроек.
  useEffect(() => {
    // Щелчок в панели сделал её фокусной: фокус поставит onMouseUp, если текст не выделяли.
    if (p.focused && !settingsOpen && !pointerDown.current) focusActive()
  }, [p.focused, settingsOpen, focusActive])

  // Команда закончилась (строка ввода снова активна) — фокус в неё, если он был в панели или нигде.
  const paneRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (running || alt || awaiting) return
    const active = document.activeElement
    const nothingFocused = !active || active === document.body
    // Строка поиска (⌘F) фокус не теряет: в ней ещё набирают.
    if (nothingFocused || (paneRef.current?.contains(active) && !active?.closest?.('.find'))) focusActive()
  }, [running, alt, awaiting, focusActive])

  // Панель агентов исчезла (⌘J или сессии больше нет), пока фокус был в ней (элемент уже удалён) — вернуть ввод.
  const agentsShown = !!claude && !agentsHidden
  useEffect(() => {
    if (agentsShown || !p.focused) return
    const active = document.activeElement
    if (!active || active === document.body) focusActive()
  }, [agentsShown, p.focused, focusActive])

  // Очередь сообщений Claude (набраны, пока ход шёл) — над строкой ввода, под запросами агента.
  const queue = claude?.queue ?? NO_QUEUE
  const queueShown = queue.length > 0 && !alt
  const queueShownRef = useRef(queueShown)
  useLayoutEffect(() => {
    queueShownRef.current = queueShown
  })
  // Очередь опустела (ушло последнее), пока фокус был в ней — вернуть ввод. Уходящая панель
  // (.queue.leaving) ещё миг держит фокус, а потом пропадает — поэтому фокус в ней тоже считается.
  useEffect(() => {
    if (queueShown || !p.focused) return
    const active = document.activeElement
    if (!active || active === document.body || active.closest?.('.queue')) focusActive()
  }, [queueShown, p.focused, focusActive])
  const queueInput = useMemo(
    () => ({
      recall: () => recallQueued(p.paneId),
      sendNext: () => sendQueued(p.paneId, cwdRef.current),
      dismissHint: () => dismissQueueHint(p.paneId),
    }),
    [p.paneId],
  )
  const onRemoveQueued = useCallback((id: number) => removeQueued(p.paneId, id), [p.paneId])
  const onSendQueuedNow = useCallback((id: number) => sendQueuedNow(p.paneId, id, cwdRef.current), [p.paneId])

  // Вопрос агента ждёт ответа — блок над строкой ввода (как «needs your input» в Warp).
  // Ждущий запрос агента (вопрос или разрешение) — блок над строкой ввода.
  const prompt = claude ? pendingPrompt(claude.state) : null
  // «? Доверять папке» и «? Открыть ссылку» — поверх (вопрос агента ждёт под ними).
  const trustAsk = useClaudeTrust((st) => st.asks[p.paneId] ?? null)
  const linkAsk = useLinkAsk((st) => st.asks[p.paneId] ?? null)
  const confirmShown = (!!trustAsk || !!linkAsk) && !alt
  const question = prompt?.type === 'question' && !confirmShown ? prompt : null
  const permission = prompt?.type === 'permission' && !confirmShown ? prompt : null
  const questionRef = useRef(question)
  useLayoutEffect(() => {
    questionRef.current = question
  })
  const promptRef = useRef<HTMLDivElement>(null)
  const focusPrompt = useCallback(() => promptRef.current?.focus(), [])
  // Новый запрос забирает фокус, если панель в фокусе, в строке ничего не набрано и пользователь
  // не занят другим (настройки, панель агентов, выбор модели). Запрос закрыт — ввод в строку.
  const promptId = confirmShown ? (trustAsk ? `trust:${trustAsk.cwd}` : `link:${linkAsk?.url}`) : (prompt?.requestId ?? null)
  // Вопрос о ссылке — ответ на щелчок пользователя: фокус к нему сразу.
  const linkFocus = confirmShown && !trustAsk
  useEffect(() => {
    if (linkFocus) {
      promptRef.current?.focus()
      return
    }
    if (!promptId) {
      const active = document.activeElement
      if (!active || active === document.body || (paneRef.current?.contains(active) && !inputRef.current?.hasFocus())) {
        if (!active?.closest?.('.agents, .queue, .find')) focusActive()
      }
      return
    }
    if (!callbacks.current.focused || runningRef.current || altRef.current) return
    if (useUi.getState().settingsOpen || useUi.getState().paletteOpen || inputRef.current?.pickerOpen()) return
    const active = document.activeElement
    if (active?.closest?.('.agents, .find')) return
    if (inputRef.current?.isEmpty() ?? true) promptRef.current?.focus()
  }, [promptId, linkFocus, focusActive])
  // «Нет» (или доверие не записалось): отложенное сообщение — обратно в строку, режим Claude — как до него.
  const onTrust = useCallback(
    (ok: boolean) => {
      void answerTrust(p.paneId, ok).then((r) => {
        const input = inputRef.current
        if (!r || !input) return
        const snap = input.snapshot()
        const doc = r.text !== null && !snap.doc.text ? docOf(r.text, r.tokens) : snap.doc
        input.restore({ doc, claude: r.leave ? false : snap.claude })
        input.focus()
        if (r.error) input.note(r.error)
      })
    },
    [p.paneId],
  )
  const onLink = useCallback((ok: boolean) => answerLink(p.paneId, ok), [p.paneId])
  const onDecideP = useCallback(
    (d: PermissionDecision) => {
      const pr = permissionRef.current
      if (pr) void answerPermission(p.paneId, pr.requestId, d)
    },
    [p.paneId],
  )
  const permissionRef = useRef(permission)
  useLayoutEffect(() => {
    permissionRef.current = permission
  })
  const onAnswerQ = useCallback(
    (index: number, text: string) => {
      const q = questionRef.current
      if (q) void answerQuestion(p.paneId, q.requestId, index, text)
    },
    [p.paneId],
  )
  const onStepQ = useCallback(
    (step: number) => {
      const q = questionRef.current
      if (q) questionStep(p.paneId, q.requestId, step)
    },
    [p.paneId],
  )
  const onSubmitQ = useCallback(() => {
    const q = questionRef.current
    if (q) void submitQuestion(p.paneId, q.requestId)
  }, [p.paneId])
  const onLeaveQ = useCallback(() => inputRef.current?.focus(), [])

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
  const onRun = useCallback(
    (cmd: string) => {
      const h = handleRef.current
      if (!h) return false
      sentRef.current = cmd
      // Эхо строки ZLE начнёт с текущей строки курсора: что выше — вывод оболочки после приглашения.
      const t = termRef.current
      echoRowRef.current = t && t.buffer.active.type === 'normal' ? cursorRow(t) : null
      // Отправка из строки — выбор блока снят: позже ⌘R не повторит давно выбранную команду.
      setSelected(null)
      setAwaitingShell(true)
      h.write(commandBytes(cmd))
      return true
    },
    [setAwaitingShell],
  )
  // ⌃D на пустой строке — EOF в оболочку, как в обычном терминале (zsh с ignoreeof его проигнорирует).
  const onEof = useCallback(() => handleRef.current?.write('\x04'), [])
  // `/btw`: побочный вопрос — ответ карточкой над очередью, разговор не меняется.
  const btw = useBtw((s) => s.byPane[p.paneId])
  const onBtw = useCallback((q: string) => askBtw(p.paneId, cwdRef.current, q), [p.paneId])
  const onEscBtw = useCallback(() => closeBtw(p.paneId), [p.paneId])
  useEffect(() => () => void closeBtw(p.paneId), [p.paneId])
  const onAsk = useCallback(
    (text: string, tokens?: Attachment[], now?: boolean) => {
      setSelected(null)
      void askClaude(p.paneId, cwdRef.current, text, tokens, now)
    },
    [p.paneId],
  )
  const onTokens = useCallback((n: number) => setAttachCount(p.paneId, n), [p.paneId])
  useEffect(() => {
    const paneId = p.paneId
    return () => {
      setAttachCount(paneId, 0)
      // Панель закрыта: её вопрос о ссылке больше не ждёт.
      answerLink(paneId, false)
    }
  }, [p.paneId])

  /** Блок или ответ Claude из ленты — значком у курсора строки ввода (из оболочки — в режим Claude). */
  /** Выделенный фрагмент ответа Claude — значком-цитатой в строку ввода («Ответить»). */
  const attachQuote = useCallback((q: QuoteSel) => {
    const it = itemsRef.current.find((x) => x.id === q.id)
    const agents = useClaudeSessions.getState().sessions[callbacks.current.paneId]?.state.agents
    const agentId = it?.kind === 'claude' && it.item.type === 'assistant' ? it.item.agentId : undefined
    inputRef.current?.insertTokens([quoteAttachment(q.text, agents?.find((a) => a.id === agentId), q.id)], { claude: true })
  }, [])
  const attachItem = useCallback((id: string | null) => {
    // В ответе выделен текст — ⌘L отвечает на фрагмент, а не вкладывает всё сообщение.
    const q = quoteSelection(feedRef.current)
    if (q) {
      attachQuote(q)
      window.getSelection()?.removeAllRanges()
      return
    }
    const it = id ? itemsRef.current.find((x) => x.id === id) : undefined
    const agents = useClaudeSessions.getState().sessions[callbacks.current.paneId]?.state.agents
    const tok = feedAttachment(it, agents)
    if (tok) inputRef.current?.insertTokens([tok], { claude: true })
  }, [attachQuote])
  // Мини-просмотр значков (строка ввода и пузыри «Вы»): ↵ — открыть файл, к блоку/сообщению, ⌫ — убрать.
  const onPreviewAction = useCallback((a: PreviewAction) => {
    const note = (t: string) => inputRef.current?.note(t)
    switch (a.type) {
      case 'open':
        openPath(a.path, a.how, a.line).catch((e: unknown) => note(`Не удалось открыть: ${String(e)}`))
        return
      case 'jump':
        if (itemsRef.current.some((x) => x.id === a.id)) setSelected(a.id)
        else note(a.kind === 'block' ? 'Этого блока уже нет в ленте' : 'Этого сообщения уже нет в ленте')
        return
      case 'remove':
        inputRef.current?.removeToken(a.id)
        return
    }
  }, [])
  const preview = usePreview({ onAction: onPreviewAction })
  /** Блоки и законченные ответы Claude ленты — для групп `@`. */
  const atFeed = useCallback((): AtFeed => {
    const blocks: ShellBlock[] = []
    const messages: AtMessage[] = []
    const agents = useClaudeSessions.getState().sessions[callbacks.current.paneId]?.state.agents ?? []
    for (const it of itemsRef.current) {
      if (it.kind === 'shell') blocks.push(it)
      else if (it.item.type === 'assistant' && !it.item.streaming && it.item.text.trim()) {
        const agentId = it.item.agentId
        messages.push({ id: it.id, text: it.item.text, agent: agents.find((g) => g.id === agentId) })
      }
    }
    return { blocks, messages }
  }, [])
  /** Отправленные сообщения Claude панели без значков (старые первыми) — поиск ⌃R в режиме Claude. */
  const claudeHistory = useCallback((): string[] => {
    const items = useClaudeSessions.getState().sessions[callbacks.current.paneId]?.state.items ?? []
    const out: string[] = []
    for (const it of items) if (it.type === 'user' && !it.tokens?.length && it.text.trim()) out.push(it.text)
    return out
  }, [])

  const copyItem = useCallback((id: string | null) => {
    const it = id ? itemsRef.current.find((x) => x.id === id) : undefined
    const text = it?.kind === 'shell' ? (it.html ? blockText(it.html) : '') : it?.item.type === 'assistant' ? it.item.text : ''
    if (text) navigator.clipboard?.writeText(text).catch(() => {})
  }, [])

  // Оболочка в простое: строка ввода активна и не ждёт продолжения (PS2) — команду можно повторить.
  const shellIdle = !running && !alt && !awaiting && !cont
  const shellIdleRef = useRef(shellIdle)
  useLayoutEffect(() => {
    shellIdleRef.current = shellIdle
  })
  /** «Повторить»: команда блока — как набранная и ↵ (в историю, черновик строки не трогаем). */
  const repeatBlock = useCallback(
    (id: string | null) => {
      const it = id ? itemsRef.current.find((x) => x.id === id) : undefined
      if (it?.kind !== 'shell' || it.running || !shellIdleRef.current) return false
      if (!onRun(it.command)) return false
      pushHistory(it.command)
      return true
    },
    [onRun],
  )
  // Колбэк стабилен (memo блоков ленты): занята ли оболочка, repeatBlock проверяет сам.
  const repeatBlockClick = useCallback(
    (id: string) => {
      if (!repeatBlock(id)) inputRef.current?.note('Повторить можно, когда оболочка свободна')
    },
    [repeatBlock],
  )
  /** «Спросить Claude»: код, каталог и хвост вывода упавшего блока — в Claude-сессию панели (занята — в очередь). */
  const askBlock = useCallback((id: string | null) => {
    const it = id ? itemsRef.current.find((x) => x.id === id) : undefined
    if (it?.kind !== 'shell' || it.running || it.exitCode === null || it.exitCode === 0) return
    const paneId = callbacks.current.paneId
    // Каталог неизвестен — askClaude покажет ошибку карточкой, режим не включаем.
    if (claudeCwdKnown(paneId, cwdRef.current)) inputRef.current?.claudeOn()
    void askClaude(paneId, cwdRef.current, failurePrompt(it.command, it.exitCode, it.cwd, blockTextOf(it)))
  }, [])

  // Перетаскивание блока (за строку команды) или ответа (за подпись) в строку ввода — значком.
  const [drag, setDrag] = useState<{ token: Attachment; x: number; y: number } | null>(null)
  const onPanePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    // Тащить можно за «⌘L в сообщение» или за заголовок (строка команды, подпись ответа);
    // за заголовок — только если мышь не выделяет текст (выделение заголовка остаётся).
    const target = e.target as Element
    const chip = !!target.closest?.('.hover-act button.on')
    const head = chip ? target : target.closest?.('.blk .bh, .card .who')
    const host = head?.closest<HTMLElement>('[data-block-id], [data-item-id]')
    const id = host?.dataset.blockId ?? host?.dataset.itemId
    if (!id) return
    const sx = e.clientX
    const sy = e.clientY
    let token: Attachment | null = null
    const stop = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', stop)
      setDrag(null)
    }
    const move = (ev: PointerEvent) => {
      if (!token) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < DRAG_MIN_PX) return
        if (!chip && !(window.getSelection()?.isCollapsed ?? true)) return stop()
        const agents = useClaudeSessions.getState().sessions[callbacks.current.paneId]?.state.agents
        token = feedAttachment(itemsRef.current.find((x) => x.id === id), agents)
        if (!token) return stop()
        window.getSelection()?.removeAllRanges()
      }
      ev.preventDefault()
      const box = paneRef.current?.getBoundingClientRect()
      setDrag({ token, x: ev.clientX - (box?.left ?? 0), y: ev.clientY - (box?.top ?? 0) })
    }
    const up = (ev: PointerEvent) => {
      stop()
      if (!token) return
      const over = typeof document.elementFromPoint === 'function' ? document.elementFromPoint(ev.clientX, ev.clientY) : null
      if (over && paneRef.current?.querySelector('.input')?.contains(over)) inputRef.current?.insertTokens([token], { claude: true })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', stop)
  }, [])

  // Файлы из Finder над этой панелью: оверлей; брошены — у курсора строки ввода.
  const dropHere = useDrop((s) => (s.paneId === p.paneId ? s.paths : null))
  /** Строка ввода в режиме Claude: брошенные файлы станут значками (иначе — путями). */
  const [acceptsTokens, setAcceptsTokens] = useState(false)
  /** Строка ввода в режиме Claude (подсказка пустой ленты — про этот режим). */
  const [inClaude, setInClaude] = useState(restored?.claudeMode === true)
  useEffect(() => registerDropTarget(p.paneId, (paths) => inputRef.current?.insertPaths(paths)), [p.paneId])
  const onClearFeed = useCallback(() => {
    // Идущий блок и незаконченный ответ Claude (с ним — всё после него) не трогаем:
    // иначе продолжение ответа после ⌃L не появилось бы.
    const from = firstUnfinished(claudePrev.current)
    claudeFrom.current = from
    setItems((it) => it.filter((x) => (x.kind === 'shell' ? x.running : claudeIndex(x.id) >= from)))
    setSelected(null)
    feedCleared(p.paneId, from)
  }, [p.paneId])
  // Быстрый вход: команда входа (ssh …) в этой панели. Лента очищается — сессия начинается заново.
  const runLauncher = useCallback(
    (cmd: string) => {
      if (!handleRef.current || !promptSeenRef.current) return false
      // `claude [вопрос]` — наши карточки, как из строки ввода (не полноэкранный TUI в PTY).
      const c = parseClaudeCommand(cmd)
      if (c.kind !== 'shell') {
        const input = inputRef.current
        if (!input) return false
        if (itemsRef.current.length > 0) onClearFeed()
        input.enterClaude(c.kind === 'ask' ? c.text : undefined)
        return true
      }
      if (itemsRef.current.length > 0) onClearFeed()
      return onRun(c.cmd)
    },
    [onClearFeed, onRun],
  )
  useEffect(() => {
    runPendingRef.current = () => {
      if (!handleRef.current || runningRef.current) return
      const cmd = takePending(p.paneId)
      if (cmd !== null) runLauncher(cmd)
    }
  })
  useEffect(
    () =>
      registerPaneRunner(p.paneId, {
        run: runLauncher,
        busy: () => runningRef.current || awaitingRef.current || claudeOpen(useClaudeSessions.getState().sessions[p.paneId]),
      }),
    [p.paneId, runLauncher],
  )
  // `claude [вопрос]` ↵ — наши карточки вместо полноэкранного TUI (в PTY ничего не уходит).
  const onEnterClaude = useCallback(
    (question?: string) => {
      // Вход в режим Claude начинается с чистой ленты (как ⌃L: идущий блок остаётся).
      if (claudeCwdKnown(p.paneId, cwdRef.current)) onClearFeed()
      if (question === undefined) return enterClaude(p.paneId, cwdRef.current)
      // Каталог неизвестен — askClaude покажет ошибку карточкой, режим не включаем.
      const ok = claudeCwdKnown(p.paneId, cwdRef.current)
      void askClaude(p.paneId, cwdRef.current, question)
      return ok
    },
    [p.paneId, onClearFeed],
  )
  // `/clear`: прежняя сессия остановлена, лента пуста целиком (недоигранный ответ тоже), дальше — новая сессия.
  const onNewClaude = useCallback(() => {
    if (claudeCwdKnown(p.paneId, cwdRef.current)) {
      const n = useClaudeSessions.getState().sessions[p.paneId]?.state.items.length ?? 0
      clearClaude(p.paneId)
      claudeFrom.current = n
      setItems((it) => it.filter((x) => (x.kind === 'shell' ? x.running : claudeIndex(x.id) >= n)))
      setSelected(null)
    }
    return enterClaude(p.paneId, cwdRef.current)
  }, [p.paneId])
  // `/exit`: сессия закрыта, лента чистится целиком (как `/clear`, идущая команда остаётся) — дальше обычный терминал.
  const onExitClaude = useCallback(() => {
    const n = useClaudeSessions.getState().sessions[p.paneId]?.state.items.length ?? 0
    exitClaude(p.paneId)
    claudeFrom.current = n
    setItems((it) => it.filter((x) => (x.kind === 'shell' ? x.running : claudeIndex(x.id) >= n)))
    setSelected(null)
  }, [p.paneId])
  // `/resume`: прошлые разговоры каталога панели; выбранный — с чистой ленты (как `/clear`), его история —
  // карточками. Лента чистится, только когда история прочитана (иначе текущий разговор остаётся).
  const onListSessions = useCallback(() => listSessions(p.paneId, cwdRef.current), [p.paneId])
  const onResume = useCallback(
    (s: SessionInfo) => {
      if (!claudeCwdKnown(p.paneId, cwdRef.current)) return false
      void resumeClaude(p.paneId, cwdRef.current, s, (n) => {
        claudeFrom.current = n
        setItems((it) => it.filter((x) => (x.kind === 'shell' ? x.running : claudeIndex(x.id) >= n)))
        setSelected(null)
      })
      return true
    },
    [p.paneId],
  )
  const onChooseModel = useCallback((c: ModelChoice) => void chooseModel(p.paneId, cwdRef.current, c), [p.paneId])
  // Текущая модель: выбранная в `/model` для панели, иначе из настроек Claude Code, иначе Default.
  // Новая ссылка при смене модели или усилия: строка ввода (memo) перерисует открытый выбор модели.
  const curModel = claude?.model
  const defModel = claude?.state.defaultModel
  const curEffort = claude?.state.effort
  const modelInfo = useCallback(() => {
    const s = useClaudeSessions.getState().sessions[p.paneId]
    return {
      current: s?.model ?? aliasOf(s?.state.defaultModel) ?? 'default',
      effort: s?.state.effort ?? null,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- значения — повод для новой ссылки, читаются из стора
  }, [p.paneId, curModel, defModel, curEffort])
  const onInterrupt = useCallback(
    (empty: boolean, claudeMode: boolean) => {
      // Режим Claude: ⌃C прерывает ход агента (если идёт), оболочку не трогает.
      if (claudeMode) return interruptClaude(p.paneId)
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

  // Правка отправленного сообщения: index — элемент ClaudeState.items, snap — черновик строки до правки.
  const [editing, setEditing] = useState<{ index: number; snap: InputSnapshot } | null>(null)
  const editingRef = useRef(editing)
  useLayoutEffect(() => {
    editingRef.current = editing
  })
  const claudeState = claude?.state
  /**
   * Сообщения «Вы», которые можно изменить (id ленты): у остальных «Изменить» не показываем.
   * Набор — новый только при смене состава (не на каждый токен ответа): лента (memo) не перерисовывается.
   */
  const editableKey = useMemo(() => {
    const ids: string[] = []
    claudeState?.items.forEach((_, i) => {
      if (canEdit(claudeState, i)) ids.push(claudeItemId(i))
    })
    return ids.join(' ')
  }, [claudeState])
  const editable = useMemo(() => new Set(editableKey ? editableKey.split(' ') : []), [editableKey])
  const editableRef = useRef(editable)
  useLayoutEffect(() => {
    editableRef.current = editable
  })
  /** Начать правку сообщения index: его текст со значками — в строку, черновик сохраняется до esc. */
  const beginEdit = useCallback((index: number) => {
    const st = useClaudeSessions.getState().sessions[callbacks.current.paneId]?.state
    const it = st?.items[index]
    const bar = inputRef.current
    if (!st || !bar || it?.type !== 'user' || !canEdit(st, index)) return false
    // Правка другого сообщения поверх идущей — черновик тот же, что был до первой.
    const snap = editingRef.current?.snap ?? bar.snapshot()
    if (!bar.load(it.tokens && it.tokens.length > 0 ? docOf(it.text, it.tokens) : docOf(it.text))) return false
    editingRef.current = { index, snap }
    setEditing({ index, snap })
    setSelected(null)
    return true
  }, [])
  const cancelEdit = useCallback(() => {
    const e = editingRef.current
    if (!e) return
    editingRef.current = null
    setEditing(null)
    inputRef.current?.restore(e.snap)
  }, [])
  const editMode = useMemo(
    () =>
      editing
        ? {
            onSubmit: (text: string, tokens?: Attachment[]) => {
              const e = editingRef.current
              if (!e) return
              editingRef.current = null
              setEditing(null)
              inputRef.current?.restore(e.snap)
              void editClaude(p.paneId, e.index, text, tokens).then((ok) => {
                if (!ok) inputRef.current?.note('Это сообщение уже нельзя изменить')
              })
            },
            onCancel: cancelEdit,
          }
        : null,
    [editing, p.paneId, cancelEdit],
  )
  const edit = editing && claudeState ? editInfo(claudeState, editing.index) : null
  // Сообщение больше нельзя изменить (другая сессия, ⌃L не в счёт) — правка отменяется, черновик возвращается.
  const editLost = !!editing && !edit
  useEffect(() => {
    if (editLost) cancelEdit()
  }, [editLost, cancelEdit])
  // Подсказка следующего сообщения: только между ходами — не во время ответа, не при очереди,
  // вопросе или запросе разрешения, не при правке сообщения; выключена в настройках — не видна.
  const suggestion =
    settings.claudePromptSuggestions && claudeState && !claudeState.busy && claudeState.pending === 0 &&
    queue.length === 0 && !prompt && !editing && !alt
      ? (claudeState.suggestion ?? null)
      : null
  const onDismissSuggestion = useCallback(() => dismissSuggestion(p.paneId), [p.paneId])
  const onEditLast = useCallback(() => {
    const st = useClaudeSessions.getState().sessions[callbacks.current.paneId]?.state
    const i = st ? lastEditable(st) : -1
    return i >= 0 && beginEdit(i)
  }, [beginEdit])
  const onEscInterrupt = useCallback(
    (empty: boolean) => {
      if (!interruptClaude(p.paneId)) return false
      if (empty) onEditLast()
      return true
    },
    [p.paneId, onEditLast],
  )
  const onEditSelected = useCallback(() => {
    const i = selectedRef.current ? claudeIndex(selectedRef.current) : -1
    return i >= 0 && beginEdit(i)
  }, [beginEdit])
  const onEditItem = useCallback((id: string) => void beginEdit(claudeIndex(id)), [beginEdit])

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
    const el = feedRef.current?.querySelector<HTMLElement>(`[data-block-id="${selected}"], [data-item-id="${selected}"]`)
    el?.scrollIntoView?.({ block: 'nearest' })
  }, [selected])

  // ⌘F — поиск в ленте; esc/✕ — закрыть, ввод — туда, где он идёт.
  const [findOpen, setFindOpen] = useState(false)
  const findRef = useRef<FindBarHandle>(null)
  const closeFind = useCallback(() => {
    setFindOpen(false)
    focusActive()
  }, [focusActive])

  useEffect(
    () =>
      registerPaneCommands(p.paneId, (a: PaneAction) => {
        // Полноэкранная программа: лента скрыта, выбирать и искать нечего.
        if (altRef.current) return
        // Палитра ⌘P: ⌃L, режим Claude, `/model` — как из строки ввода.
        if (a === 'clearFeed') return onClearFeed()
        if (a === 'claudeToggle') return inputRef.current?.toggleClaude()
        if (a === 'chooseModel') return inputRef.current?.openModelPicker()
        if (a === 'resumeClaude') return inputRef.current?.openResumePicker()
        if (a === 'historySearch') return inputRef.current?.openHistorySearch()
        // ⌘F: строка поиска; уже открыта — фокус в неё.
        if (a === 'find') {
          if (findRef.current) findRef.current.focus()
          else setFindOpen(true)
          return
        }
        if (a === 'blockCopy') {
          copyItem(selectedRef.current)
          return
        }
        // ⌘⇧A: выбранный упавший блок — «Спросить Claude».
        if (a === 'blockAsk') {
          askBlock(selectedRef.current)
          return
        }
        // ⌘R на выбранном блоке оболочки (режим чтения закрыт) — «Повторить».
        if (a === 'blockRead' && !readerIdRef.current) {
          const sel = itemsRef.current.find((it) => it.id === selectedRef.current)
          if (sel?.kind === 'shell') {
            if (!repeatBlock(sel.id)) inputRef.current?.note('Повторить можно, когда оболочка свободна')
            return
          }
        }
        // ⌘R: выбранный ответ (или последний ответ в ленте) — в режиме чтения; повторно — закрыть.
        if (a === 'blockRead') {
          setReaderId((cur) => {
            const list = itemsRef.current
            const isAnswer = (it: FeedItem | undefined) => it?.kind === 'claude' && it.item.type === 'assistant'
            // Открытый ответ мог уйти в «Прежний вариант» (правка сообщения) — тогда открываем заново.
            if (cur && list.some((it) => it.id === cur && isAnswer(it))) return null
            const sel = list.find((it) => it.id === selectedRef.current)
            if (isAnswer(sel)) return sel!.id
            for (let i = list.length - 1; i >= 0; i--) if (isAnswer(list[i])) return list[i].id
            return null
          })
          return
        }
        // ⌘L: выбранный блок или ответ — значком в строку ввода (макет 06, сцена Г).
        if (a === 'blockAttach') {
          attachItem(selectedRef.current)
          return
        }
        // ⌘↓ из строки ввода при ждущем вопросе агента — к вопросу.
        if (a === 'blockNext' && promptRef.current && inputRef.current?.hasFocus()) {
          focusPrompt()
          return
        }
        // ⌘↓: строка ввода (или вопрос) → очередь сообщений (если не пуста) → панель агентов.
        if (a === 'blockNext' && queueRef.current?.hasFocus()) {
          agentsRef.current?.focus()
          return
        }
        const inPrompt = !!promptRef.current?.contains(document.activeElement)
        if (a === 'blockNext' && queueShownRef.current && (inputRef.current?.hasFocus() || inPrompt)) {
          setSelected(null)
          queueRef.current?.focus()
          return
        }
        // Сообщения «Вы», которые можно изменить, тоже выбираются (E — изменить).
        const m = moveSelection(itemsRef.current, selectedRef.current, a === 'blockPrev' ? 'up' : 'down', (it) => editableRef.current.has(it.id))
        setSelected(m.id)
        // ⌘↓ с последнего блока или из строки ввода — фокус в панель агентов (если она показана).
        if (m.leave) agentsRef.current?.focus()
      }, () => ({ claude: inputRef.current?.claudeMode() ?? false })),
    [p.paneId, focusPrompt, attachItem, copyItem, onClearFeed, askBlock, repeatBlock],
  )

  const readerItem = readerId ? items.find((it) => it.id === readerId) : undefined
  const closeReader = useCallback(() => {
    setReaderId(null)
    inputRef.current?.focus()
  }, [])

  const liveHeight = Math.min(hostHeight, livePx)
  // Стабильные пропсы ленты (memo): токены ответа Claude и рендеры панели без её изменений ленту не перерисовывают.
  const renderLive = useCallback(
    (_b: ShellBlock) =>
      alt ? null : (
        <LiveTerminal host={host} parkRef={parkRef} mode="block" hostHeight={hostHeight} height={liveHeight} onAttach={onAttach} onDetach={onDetach} />
      ),
    [alt, host, hostHeight, liveHeight, onAttach, onDetach],
  )
  const feedPark = useMemo(
    () => (
      // Пока xterm не показан, он стоит здесь: невидим, но сохраняет ширину текста блока (cols).
      // inert: спрятанный xterm не получает фокус по Tab/⇧Tab (ввод вслепую в ZLE).
      <div className="feed-park" inert>
        <div className="blk" ref={parkRef} />
      </div>
    ),
    [],
  )

  return (
    <div
      className="pane"
      ref={paneRef}
      data-pane-id={p.paneId}
      onFocus={() => callbacks.current.onFocus()}
      // Панель — фокусная и по щелчку, а не только по фокусу элемента: в WebKit щелчок по кнопке,
      // по тексту ленты или выделение мышью фокус не переносят, и ⌘W закрыл бы прежнюю панель.
      onPointerDownCapture={() => {
        pointerDown.current = true
        const up = () => {
          pointerDown.current = false
          window.removeEventListener('pointerup', up, true)
          window.removeEventListener('pointercancel', up, true)
        }
        window.addEventListener('pointerup', up, true)
        window.addEventListener('pointercancel', up, true)
        callbacks.current.onFocus()
      }}
      onPointerDown={onPanePointerDown}
      // Клик по ленте возвращает ввод туда, где он идёт: в строку ввода, а пока идёт команда — в xterm.
      onMouseUp={(e) => {
        // Кнопки ленты («Показать всё» и т. п.), само поле и выделение текста не трогаем.
        if ((e.target as Element).closest?.('button, a, input, textarea, select, .input, .agents, .aprompt, .queue, .find')) return
        if (window.getSelection()?.isCollapsed ?? true) {
          if (runningRef.current || altRef.current) termRef.current?.focus()
          else inputRef.current?.focus()
        }
      }}
    >
      <PreviewContext.Provider value={preview.api}>
      <Feed
        ref={feedRef}
        items={items}
        agents={claude?.state.agents}
        cwd={claude?.cwd}
        selectedId={selected}
        renderLive={renderLive}
        onScroll={onFeedScroll}
        onAttach={attachItem}
        onCopy={copyItem}
        onRepeat={repeatBlockClick}
        repeatOff={!shellIdle}
        onAsk={askBlock}
        onRead={setReaderId}
        editable={editable}
        onEdit={onEditItem}
        editingId={editing ? claudeItemId(editing.index) : null}
        claudeMode={inClaude}
        thinking={claudeState ? thinkingSince(claudeState) : null}
        bgWait={claudeState ? backgroundWait(claudeState) : 0}
        park={feedPark}
      />
      </PreviewContext.Provider>
      {!alt && <QuoteReply feedRef={feedRef} onQuote={attachQuote} />}
      {findOpen && !alt && <FindBar ref={findRef} paneId={p.paneId} feedRef={feedRef} onClose={closeFind} />}
      <div className="dock">
        {claudeOpen(claude) && !agentsHidden && (
          <ErrorBoundary name="панель агентов">
            <AgentsPanel ref={agentsRef} state={claude.state} queued={queue.length} onExit={focusInput} />
          </ErrorBoundary>
        )}
        {trustAsk && !alt && (
          <ErrorBoundary name="доверие к папке" resetKey={trustAsk}>
            <TrustPrompt key={trustAsk.cwd} ref={promptRef} cwd={trustAsk.cwd} onAnswer={onTrust} />
          </ErrorBoundary>
        )}
        {linkAsk && !trustAsk && !alt && (
          <ErrorBoundary name="открытие ссылки" resetKey={linkAsk}>
            <LinkPrompt key={linkAsk.url} ref={promptRef} url={linkAsk.url} host={linkAsk.host} text={linkAsk.text} onAnswer={onLink} />
          </ErrorBoundary>
        )}
        {/* После ответа вопрос сворачивается по высоте (src/ui/motion.tsx). */}
        <Collapse open={!!question && !alt}>
        {question && !alt && (
          <ErrorBoundary name="вопрос агента" resetKey={question}>
          <QuestionPrompt
            ref={promptRef}
            item={question}
            agent={claude?.state.agents.find((a) => a.id === question.agentId)}
            onAnswer={onAnswerQ}
            onStep={onStepQ}
            onSubmit={onSubmitQ}
            onLeave={onLeaveQ}
          />
          </ErrorBoundary>
        )}
        </Collapse>
        {permission && !alt && (
          <ErrorBoundary name="запрос разрешения" resetKey={permission}>
          <PermissionPrompt
            key={permission.requestId}
            ref={promptRef}
            item={permission}
            agent={claude?.state.agents.find((a) => a.id === permission.agentId)}
            onDecide={onDecideP}
            onLeave={onLeaveQ}
          />
          </ErrorBoundary>
        )}
        {btw && !alt && (
          <ErrorBoundary name="побочный вопрос" resetKey={btw.seq}>
            <BtwCard answer={btw} onClose={() => {
              closeBtw(p.paneId)
              inputRef.current?.focus()
            }} />
          </ErrorBoundary>
        )}
        {/* Смонтирована и при пустой очереди: уход последней строки анимируется (QueuePanel рисует null). */}
        {!alt && (
          <ErrorBoundary name="очередь сообщений">
          <QueuePanel
            ref={queueRef}
            queue={queue}
            paused={!!claude?.pauseHint}
            onRemove={onRemoveQueued}
            onSendNow={onSendQueuedNow}
            onExit={focusInput}
          />
          </ErrorBoundary>
        )}
        {edit && !alt && (
          <ErrorBoundary name="правка сообщения">
            <EditChip info={edit} />
          </ErrorBoundary>
        )}
        <InputBar
          ref={inputRef}
          initialClaudeMode={restored?.claudeMode}
          queue={queueInput}
          edit={editMode}
          onEditLast={onEditLast}
          onEditSelected={onEditSelected}
          disabled={running || alt || awaiting}
          continuation={cont}
          completions={p.focused && !settingsOpen && settings.pathCompletions}
          atFiles={p.focused && !settingsOpen}
          hints={p.focused && !settingsOpen}
          cwd={getCwd}
          home={home || null}
          onRun={onRun}
          onAsk={onAsk}
          claudeBusy={!!claude?.state.busy}
          onTokens={onTokens}
          onAcceptsTokens={setAcceptsTokens}
          onClaudeMode={setInClaude}
          onEnterClaude={onEnterClaude}
          onNewClaude={onNewClaude}
          onExitClaude={onExitClaude}
          onChooseModel={onChooseModel}
          modelInfo={modelInfo}
          onListSessions={onListSessions}
          onResume={onResume}
          onInterrupt={onInterrupt}
          onEscInterrupt={onEscInterrupt}
          onEof={onEof}
          onBtw={onBtw}
          onEscBtw={onEscBtw}
          onClearFeed={onClearFeed}
          preview={preview.api}
          atFeed={atFeed}
          claudeHistory={claudeHistory}
          suggestion={suggestion}
          onDismissSuggestion={onDismissSuggestion}
        />
      </div>
      {alt && (
        <LiveTerminal host={host} parkRef={parkRef} mode="overlay" hostHeight={hostHeight} height={0} onAttach={onAttach} onDetach={onDetach} />
      )}
      {dropHere && !alt && !(running || awaiting) && (
        <div className="drop" aria-live="polite">
          <div className="zone">
            <svg width="34" height="34" viewBox="0 0 24 24" aria-hidden="true">
              <path d={DROP_PATH} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {acceptsTokens ? DROP_TITLE : dropHere.length > 1 ? DROP_TITLE_SHELL_MANY : DROP_TITLE_SHELL}
            <small>{dropSubline(dropHere)}</small>
          </div>
        </div>
      )}
      {readerItem && readerItem.kind === 'claude' && readerItem.item.type === 'assistant' && (
        <ErrorBoundary name="режим чтения">
          <ReaderView
            title={agentSignature(claude?.state.agents.find((a) => a.id === (readerItem.item as { agentId: string }).agentId))}
            text={readerItem.item.text}
            streaming={readerItem.item.streaming}
            onClose={closeReader}
          />
        </ErrorBoundary>
      )}
      <ErrorBoundary name="мини-просмотр" resetKey={preview.state}>
        <PreviewLayer state={preview.state} api={preview.api} container={paneRef} cwd={getCwd} home={home} />
      </ErrorBoundary>
      {drag && (
        <div className="tk-ghost" style={{ left: drag.x + 12, top: drag.y + 10 }} aria-hidden="true">
          <Token token={drag.token} />
        </div>
      )}
    </div>
  )
}

export default TerminalPane
