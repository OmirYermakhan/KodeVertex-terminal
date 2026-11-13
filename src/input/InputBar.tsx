// Строка ввода панели (как в Warp, макет 04-main-window `.input`): ↵ — команда в оболочку,
// ⌘↵ — вопрос Claude, ↑/↓ — история, подсказки путей — попап над полем.
// `claude` ↵ — режим Claude: ↵ шлёт вопросы агенту, `/exit`, `exit` или esc на пустой строке — выход.
// В режиме Claude в текст встают значки вложений (макет 06-attachments): поле — contenteditable,
// модель — Doc (текст + значки), см. src/attach/doc.ts и richDom.ts.
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useCompletion } from '../completion/useCompletion'
import { CompletionPopup, LIST_WIDTH, PREVIEW_WIDTH, popupHeight } from '../completion/CompletionPopup'
import { useHints } from '../completion/useHints'
import { HintsPopup } from '../completion/HintsPopup'
import { shellEscape } from '../completion/completion'
import { isClaudeExit, isClearCommand, isModelCommand, isShellClear, parseClaudeCommand } from './claudeCommand'
import { ModelPicker } from '../claude/ModelPicker'
import { initialPicker, pickerKey, type ModelChoice, type PickerState } from '../claude/models'
import { getHistory, historyStep, loadHistory, NAV_START, pushHistory, type HistoryNav } from './history'
import { backspace, countTokens, docOf, forwardDelete, insertText, insertTokens, moveCaret, readable, splice, tokenAt, tokenPos, type Edit } from '../attach/doc'
import { effective, overBudget, pathAttachment, sendBlocked } from '../attach/classify'
import { attachPaths, pasteClipboardImage, pickFiles, screenshotLabel } from '../attach/api'
import { CLIP_PATH } from '../attach/tokenView'
import { EMPTY_DOC, type Attachment, type Doc } from '../attach/types'
import { domPoint, getSelection, readDoc, renderDoc, setSelection } from './richDom'
import { atContext, AT_COMMAND, type CompletionContext } from '../completion/completion'
import { atRows, type AtFeed, type AtRow } from '../attach/atSearch'
import { AtPicker } from '../attach/AtPicker'
import { blockAttachment, messageAttachment } from '../attach/fromFeed'
import type { PreviewApi } from '../attach/preview/usePreview'

/** Поле растёт до стольких строк, дальше — прокрутка внутри. */
export const MAX_ROWS = 8
/** Зазор между попапом подсказок и полем, px. */
const POPUP_GAP = 4

export const PLACEHOLDER = 'Команда или вопрос Claude…'
export const ASK_HINT = '⌘↵ отправить агенту'
export const CLAUDE_PLACEHOLDER = 'Вопрос Claude…'
export const CLAUDE_HINT = '↵ отправить агенту · /exit выйти'
/** Метка режима Claude слева в поле. */
export const CLAUDE_MARK = '◆'
export const ANSWER_PLACEHOLDER = 'Ваш ответ на вопрос…'
export const ANSWER_HINT = '↵ ответить · esc к вопросу'
export const EDIT_PLACEHOLDER = 'Исправленное сообщение…'
export const EDIT_HINT = '↵ отправить исправленное · esc отменить'
export const CONTINUATION_NOTE = 'Команда не закончена — допишите или ⌃C'
/** ↵ при красном значке: сообщение не уходит. */
export const UNSUPPORTED_NOTE = 'Красные вложения Claude не примет — уберите их (⌫⌫), чтобы отправить'
export const CLIP_LABEL = 'Вложить файлы (⌘O)'
/** Курсор рядом со значком (макет 06, сцена Б). */
export const PREVIEW_HINT = '␣ просмотр'
/** Боковой просмотр в `@` — только если строка не уже этого. */
const AT_SIDE_MIN = 600
const NOTE_MS = 3500

export interface InputBarProps {
  /** Идёт shell-команда: строка неактивна, ввод — в живом терминале. */
  disabled: boolean
  /** Подсказки путей разрешены (панель в фокусе, настройки закрыты, включены в настройках). */
  completions: boolean
  /**
   * `@путь` в режиме Claude разрешён (панель в фокусе, настройки закрыты). Это способ вставки,
   * а не подсказка оболочки: от настройки подсказок путей не зависит. Нет — как completions.
   */
  atFiles?: boolean
  /** Выборка `claude …` / `/…` разрешена (панель в фокусе, настройки закрыты). */
  hints?: boolean
  cwd: () => string | undefined
  home: string | null
  /** Оболочка ждёт продолжения команды (PS2): над полем подсказка. */
  continuation?: boolean
  /** ↵: команда в оболочку; false — не отправлена (оболочка не готова), строка остаётся. */
  onRun(cmd: string): boolean
  /**
   * ⌘↵ (или ↵ в режиме Claude): вопрос в Claude-сессию панели. Со значками — text содержит
   * TOKEN_CHAR на их местах, tokens — значки по порядку.
   */
  onAsk(text: string, tokens?: Attachment[]): void
  /**
   * `claude [вопрос]` ↵: сессия запускается (вопрос — если есть). true — панель входит в режим Claude;
   * false — не удалось (каталог неизвестен, ошибка — карточкой), режим не включается.
   */
  onEnterClaude(question?: string): boolean
  /**
   * ⌃C (empty — строка пуста, claude — режим Claude): true — прерван ход Claude, строку не трогаем;
   * false — строка очищается.
   */
  onInterrupt(empty: boolean, claude: boolean): boolean
  /** ⌃L (и `clear` в оболочке): очистить ленту. */
  onClearFeed(): void
  /**
   * `/clear` ↵ (в любом режиме): новая сессия Claude с чистой лентой. true — панель в режиме Claude;
   * false — не удалось (каталог неизвестен). Нет — `/clear` уходит как набран.
   */
  onNewClaude?(): boolean
  /** `/exit` (в любом режиме) или `exit` в режиме Claude: закрыть Claude панели. */
  onExitClaude?(): void
  /** ⌃D на пустой строке: EOF в оболочку. */
  onEof?(): void
  /** `/model` (в любом режиме: в оболочке это не команда): выбор модели. Нет — `/model` уходит как набран. */
  onChooseModel?(choice: ModelChoice): void
  /** Текущие модель (псевдоним, null — по умолчанию) и усилие панели — для карточки выбора. */
  modelInfo?(): { current: string | null; effort: string | null }
  /** «Свой ответ…» на вопрос агента: ↵ отдаёт текст сюда, esc — назад к вопросу. */
  answer?: { onSubmit(text: string): void; onCancel(): void } | null
  /**
   * Очередь сообщений Claude: ↑ в пустой строке — последнее обратно (со значками; null — очередь пуста);
   * ↵ в пустой строке — следующее (после паузы); esc — убрать подсказку паузы (true — была).
   */
  queue?: { recall(): string | Doc | null; sendNext(): boolean; dismissHint(): boolean }
  /**
   * Правка отправленного сообщения: ↵ (или ⌘↵) отдаёт исправленный текст со значками сюда, esc —
   * отмена. Строку после ↵ не очищаем: родитель возвращает в неё прежний черновик.
   */
  edit?: { onSubmit(text: string, tokens?: Attachment[]): void; onCancel(): void } | null
  /** ↑ в пустой строке режима Claude при пустой очереди: изменить последнее сообщение; false — нечего. */
  onEditLast?(): boolean
  /** E в пустой строке: изменить выбранное ⌘↑ сообщение; false — выбрано не сообщение «Вы». */
  onEditSelected?(): boolean
  /** Число значков в строке изменилось (сегмент «вложения N» в статус-баре). */
  onTokens?(n: number): void
  /** Строка стала (или перестала) принимать значки: режим Claude и не ответ на вопрос. */
  onAcceptsTokens?(yes: boolean): void
  /** Мини-просмотр значков (наведение, ␣ у значка); клавиши в открытый просмотр идут отсюда. */
  preview?: PreviewApi
  /** Блоки и ответы Claude ленты — группы «Блоки» и «Сообщения» в `@`. */
  atFeed?(): AtFeed
}

export interface InputBarHandle {
  focus(): void
  /** Фокус сейчас в поле. */
  hasFocus(): boolean
  /** В поле ничего не набрано. */
  isEmpty(): boolean
  /** Открыта карточка выбора модели (`/model`). */
  pickerOpen(): boolean
  /** Строка в режиме Claude (значки вставляются значками, а не путями). */
  claudeMode(): boolean
  /** Строка принимает значки сейчас (режим Claude, не ответ на вопрос). */
  acceptsTokens(): boolean
  /**
   * Значки у курсора (⌘L, перетаскивание блока). claude — сначала переключить строку в режим
   * Claude (из оболочки). false — не вставлено (строка неактивна или пишет ответ на вопрос).
   */
  insertTokens(tokens: Attachment[], opts?: { claude?: boolean }): boolean
  /** Переключить строку в режим Claude (набранное остаётся). false — строка неактивна или пишет ответ. */
  claudeOn(): boolean
  /** Файлы у курсора: в режиме Claude — значками, в оболочке — экранированными путями. */
  insertPaths(paths: string[]): void
  /** Убрать значок (⌫ в мини-просмотре); false — его уже нет. */
  removeToken(id: string): boolean
  /** Подсказка над полем (ошибка открытия файла, блока нет в ленте). */
  note(text: string): void
  /** Что сейчас в строке (текст со значками и режим) — чтобы вернуть после правки сообщения. */
  snapshot(): InputSnapshot
  /** Вернуть строку из snapshot. */
  restore(s: InputSnapshot): void
  /** Текст со значками — в строку для правки (режим Claude, курсор в конце). false — строка неактивна. */
  load(d: Doc): boolean
}

export interface InputSnapshot {
  doc: Doc
  claude: boolean
}

const onFirstLine = (v: string, pos: number) => !v.slice(0, pos).includes('\n')
const onLastLine = (v: string, pos: number) => !v.slice(pos).includes('\n')

/** Пути для оболочки: экранированные, через пробел (как Terminal.app при перетаскивании). */
export const shellPaths = (paths: string[]) => paths.map((p) => shellEscape(p)).join(' ')

export const InputBar = forwardRef<InputBarHandle, InputBarProps>(function InputBar(p, ref) {
  const edRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLSpanElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  /** Текст строки со значками; docRef — актуальное значение для обработчиков. */
  const [doc, setDocState] = useState<Doc>(EMPTY_DOC)
  const docRef = useRef<Doc>(EMPTY_DOC)
  /** Значок, выделенный первым ⌫/⌦ или кликом (`.tk.sel`). */
  const selTok = useRef<string | null>(null)
  /** Счётчик перерисовок поля из модели (набор браузером поле не перерисовывает). */
  const [renderSeq, setRenderSeq] = useState(0)
  /** Курсор, который надо выставить после перерисовки. */
  const pendingCursor = useRef<number | null>(null)
  /** Курсор, пока поле не в фокусе (выставляется при фокусе). */
  const savedCursor = useRef<number | null>(null)
  /** Значки последней строки с ними: история и черновик возвращают текст без значков. */
  const lastTokens = useRef<Attachment[]>([])
  const [focused, setFocused] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const noteTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  /** Режим Claude панели: ↵ — вопрос агенту, подсказки путей выключены. */
  const [claudeMode, setClaudeModeState] = useState(false)
  const claudeRef = useRef(false)
  const setClaudeMode = useCallback((v: boolean) => {
    claudeRef.current = v
    setClaudeModeState(v)
  }, [])
  /** Открытая карточка выбора модели (`/model`); null — закрыта. */
  const [picker, setPicker] = useState<PickerState | null>(null)
  const pickerRef = useRef<PickerState | null>(null)
  const setPickerState = useCallback((v: PickerState | null) => {
    pickerRef.current = v
    setPicker(v)
  }, [])
  const nav = useRef<HistoryNav>(NAV_START)
  /** `@…` у курсора в режиме Claude (выбор с группами); null — нет. */
  const [at, setAtState] = useState<{ ctx: CompletionContext; lineStart: number } | null>(null)
  const atRef = useRef<typeof at>(null)
  const setAt = useCallback((v: { ctx: CompletionContext; lineStart: number } | null) => {
    const c = atRef.current
    if (c === v || (c && v && c.lineStart === v.lineStart && c.ctx.tokenStart === v.ctx.tokenStart && c.ctx.token === v.ctx.token)) return
    atRef.current = v
    setAtState(v)
  }, [])
  /** Строка (`курсор;текст`), на которой выбор `@` закрыли по esc: до её изменения не открываем. */
  const atDismissed = useRef<string | null>(null)
  const [atSel, setAtSelState] = useState(0)
  const atSelRef = useRef(0)
  const setAtSel = useCallback((i: number) => {
    atSelRef.current = i
    setAtSelState(i)
  }, [])
  /** Курсор у значка: ␣ откроет просмотр (подсказка справа). */
  const [nearTok, setNearTok] = useState(false)
  const props = useRef(p)
  useEffect(() => {
    props.current = p
  })
  useEffect(() => () => clearTimeout(noteTimer.current), [])

  const showNote = useCallback((text: string) => {
    clearTimeout(noteTimer.current)
    setNote(text)
    noteTimer.current = setTimeout(() => setNote(null), NOTE_MS)
  }, [])

  const hasFocus = () => !!edRef.current && document.activeElement === edRef.current

  /**
   * Значок для ␣: выделенный (первое ⌫) или стоящий сразу ПОСЛЕ курсора. Курсор после значка — там,
   * где он оказывается после вставки, — ␣ печатает обычный пробел.
   */
  const nearToken = useCallback((): Attachment | null => {
    const d = docRef.current
    if (selTok.current) {
      const t = d.tokens.find((x) => x.id === selTok.current)
      if (t) return t
    }
    const el = edRef.current
    const s = el && document.activeElement === el ? getSelection(el) : null
    if (!s || s.start !== s.end) return null
    return tokenAt(d, s.start)
  }, [])
  const syncNear = () => setNearTok(!!props.current.preview && claudeRef.current && !props.current.disabled && nearToken() !== null)
  /** Выделение модели: из DOM, если фокус в поле, иначе — сохранённый курсор (или конец). */
  const selection = useCallback(() => {
    const el = edRef.current
    const len = docRef.current.text.length
    const s = el && document.activeElement === el ? getSelection(el) : null
    if (s) return { start: Math.min(s.start, len), end: Math.min(s.end, len) }
    const c = Math.min(savedCursor.current ?? pendingCursor.current ?? len, len)
    return { start: c, end: c }
  }, [])

  /** Новая модель строки: поле перерисуется, курсор встанет в cursor. */
  const setDoc = useCallback((d: Doc, cursor: number, selected: string | null = null) => {
    if (d.tokens.length > 0) lastTokens.current = d.tokens
    docRef.current = d
    selTok.current = selected
    pendingCursor.current = cursor
    setDocState(d)
    setRenderSeq((n) => n + 1)
  }, [])

  /** Текст без значков (история, подстановки): значки остаются, если их символы на месте. */
  const setLine = useCallback(
    (v: string, cursor: number) => {
      const n = countTokens(v)
      const cur = docRef.current.tokens
      const tokens = n === cur.length ? cur : n === lastTokens.current.length ? lastTokens.current : []
      setDoc(docOf(v, tokens), cursor)
    },
    [setDoc],
  )

  const apply = useCallback((e: Edit) => setDoc(e.doc, e.caret, e.selected), [setDoc])

  // Перерисовка поля из модели (не после набора: там DOM уже верный).
  useLayoutEffect(() => {
    const el = edRef.current
    if (!el) return
    const keep = pendingCursor.current === null && document.activeElement === el ? getSelection(el) : null
    // Вложения сверх лимита сообщения — красными, с причиной (как неподдерживаемые).
    const over = overBudget(docRef.current.tokens)
    renderDoc(el, docRef.current, selTok.current, !props.current.preview, (t) => effective(t, over))
    const cursor = pendingCursor.current
    pendingCursor.current = null
    if (cursor !== null) {
      if (document.activeElement === el) setSelection(el, cursor)
      else savedCursor.current = cursor
    } else if (keep) setSelection(el, keep.start, keep.end)
    syncNear()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderSeq])

  useEffect(() => {
    p.onTokens?.(doc.tokens.length)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.tokens.length])

  const accepting = claudeMode && !p.answer
  useEffect(() => {
    props.current.onAcceptsTokens?.(accepting)
  }, [accepting])

  useEffect(() => {
    void loadHistory()
  }, [])

  /** Строка принимает значки: режим Claude и не ответ на вопрос агента. */
  const acceptsTokens = () => claudeRef.current && !props.current.answer

  const submit = useCallback((text: string, ask: boolean) => {
    const q = props.current
    const tokens = docRef.current.tokens
    if (q.answer) {
      q.answer.onSubmit(readable(docOf(text, tokens)).trim())
    } else if (q.edit) {
      const d = docOf(text, tokens)
      if (sendBlocked(d.tokens)) {
        showNote(UNSUPPORTED_NOTE)
        return
      }
      completionRef.current.close()
      hintsRef.current.close()
      setAt(null)
      nav.current = NAV_START
      // Строку не чистим: родитель сразу возвращает в неё черновик (restore).
      q.edit.onSubmit(d.text, d.tokens.length > 0 ? d.tokens : undefined)
      return
    } else if (!q.continuation && isClearCommand(text) && q.onNewClaude) {
      completionRef.current.close()
      hintsRef.current.close()
      if (q.onNewClaude()) setClaudeMode(true)
    } else if (!q.continuation && isModelCommand(text) && q.onChooseModel) {
      const info = q.modelInfo?.() ?? { current: null, effort: null }
      completionRef.current.close()
      hintsRef.current.close()
      setPickerState(initialPicker(info.current, info.effort))
    } else if (!q.continuation && (text.trim() === '/exit' || (claudeRef.current && isClaudeExit(text)))) {
      // Как выход из claude в терминале: сессия закрывается, строка — снова оболочка.
      q.onExitClaude?.()
      setClaudeMode(false)
    } else if (ask || claudeRef.current) {
      const d = docOf(text, tokens)
      // Красный значок (видео, аудио, больше лимита) не уйдёт: сообщение остаётся в строке.
      if (sendBlocked(d.tokens)) {
        showNote(UNSUPPORTED_NOTE)
        return
      }
      if (d.tokens.length > 0) props.current.onAsk(d.text, d.tokens)
      else props.current.onAsk(d.text)
    } else {
      // Значки бывают только в режиме Claude; на всякий случай — читаемым видом.
      const line = readable(docOf(text, tokens))
      if (!props.current.continuation && isShellClear(line)) {
        props.current.onClearFeed()
        pushHistory(line)
        nav.current = NAV_START
        setLine('', 0)
        completionRef.current.reset()
        hintsRef.current.reset()
        return
      }
      // Продолжение незаконченной команды (PS2) — это не команда `claude`.
      const c = props.current.continuation ? { kind: 'shell' as const, cmd: line } : parseClaudeCommand(line)
      if (c.kind === 'shell') {
        if (!props.current.onRun(c.cmd)) {
          setLine(line, line.length)
          return
        }
      } else {
        completionRef.current.close()
        if (props.current.onEnterClaude(c.kind === 'ask' ? c.text : undefined)) setClaudeMode(true)
      }
      pushHistory(line)
    }
    nav.current = NAV_START
    lastTokens.current = []
    setLine('', 0)
    completionRef.current.reset()
    hintsRef.current.reset()
  }, [setLine, setClaudeMode, setPickerState, showNote, setAt])

  /** Значки у курсора (заменяя выделение). */
  const putTokens = useCallback(
    (toks: Attachment[], range?: { start: number; end: number }) => {
      if (toks.length === 0) return
      completionRef.current.close()
      apply(insertTokens(docRef.current, range ?? selection(), toks))
    },
    [apply, selection],
  )

  /** Текст у курсора (заменяя выделение). */
  const putText = useCallback(
    (s: string) => {
      if (!s) return
      apply(insertText(docRef.current, selection(), s))
      // Правка строки — выход из истории.
      nav.current = NAV_START
      report()
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [apply, selection],
  )

  const insertPaths = useCallback(
    (paths: string[]) => {
      if (paths.length === 0 || props.current.disabled) return
      if (!acceptsTokens()) {
        const sel = selection()
        const prev = docRef.current.text[sel.start - 1]
        putText((prev !== undefined && !/\s/.test(prev) ? ' ' : '') + shellPaths(paths))
        return
      }
      attachPaths(paths)
        .then((toks) => putTokens(toks))
        .catch((e: unknown) => showNote(`Не удалось вложить: ${String(e)}`))
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [putText, putTokens, selection, showNote],
  )

  const openDialog = useCallback(() => {
    pickFiles()
      .then((paths) => {
        insertPaths(paths)
        edRef.current?.focus()
      })
      .catch(() => {})
  }, [insertPaths])

  const completion = useCompletion({
    cwd: () => props.current.cwd(),
    home: p.home,
    mode: () => (claudeRef.current ? 'at' : 'shell'),
    replace: (v, cursor, run) => {
      if (run) return submit(v, false)
      setLine(v, cursor)
      // Подставили каталог — сразу показать его содержимое.
      updateAt(v, cursor)
      completionRef.current.update(v, cursor)
    },
    insert: (path, isDir, from, to) => {
      setAt(null)
      // `@путь` выбран: значок вместо набранного `@…` (сразу; размер уточняет Rust).
      const name = path.split('/').pop() || path
      const quick = pathAttachment({ path, name, exists: true, isDir, size: 0 })
      apply(insertTokens(splice(docRef.current, from, to, '').doc, { start: from, end: from }, [quick]))
      attachPaths([path])
        .then(([t]) => {
          if (!t) return
          const d = docRef.current
          const i = d.tokens.findIndex((x) => x.id === quick.id)
          if (i < 0) return
          const tokens = d.tokens.slice()
          tokens[i] = { ...t, id: quick.id }
          const next = { ...d, tokens }
          docRef.current = next
          setDocState(next)
          setRenderSeq((n) => n + 1)
        })
        .catch(() => {})
    },
  })
  const completionRef = useRef(completion)
  useEffect(() => {
    completionRef.current = completion
  })

  // Выборка `claude …` (оболочка) и `/…` (режим Claude): ↵ после ↑↓ — выполнить/отправить выбранное.
  const hints = useHints({
    mode: () => (claudeRef.current ? 'claude' : 'shell'),
    cwd: () => props.current.cwd(),
    replace: (v, cursor, run) => {
      if (run) return submit(v, false)
      setLine(v, cursor)
      hintsRef.current.update(v, cursor)
    },
  })
  const hintsRef = useRef(hints)
  useEffect(() => {
    hintsRef.current = hints
  })
  useEffect(() => {
    if (!p.hints || p.disabled || p.continuation) hintsRef.current.close()
  }, [p.hints, p.disabled, p.continuation])

  // Попап разрешён только в активной панели.
  const pathsOn = claudeMode ? (p.atFiles ?? p.completions) : p.completions
  useEffect(() => {
    if (!pathsOn || p.disabled) completionRef.current.close()
  }, [pathsOn, p.disabled])

  // Выключенная строка (идёт команда) не держит фокус — как выключенная textarea; её просмотр закрыт.
  useEffect(() => {
    if (p.disabled && edRef.current && document.activeElement === edRef.current) edRef.current.blur()
    if (p.disabled) {
      props.current.preview?.closeFrom('input')
      setNearTok(false)
    }
  }, [p.disabled])

  useImperativeHandle(ref, () => ({
    focus: () => {
      if (!props.current.disabled) edRef.current?.focus()
    },
    hasFocus,
    isEmpty: () => docRef.current.text === '',
    pickerOpen: () => pickerRef.current !== null,
    claudeMode: () => claudeRef.current,
    acceptsTokens: () => acceptsTokens() && !props.current.disabled,
    insertTokens: (toks, opts) => {
      if (props.current.disabled || props.current.answer) return false
      if (!claudeRef.current) {
        if (!opts?.claude) return false
        completionRef.current.close()
        hintsRef.current.close()
        setClaudeMode(true)
      }
      putTokens(toks)
      edRef.current?.focus()
      return true
    },
    claudeOn: () => {
      if (props.current.disabled || props.current.answer) return false
      if (!claudeRef.current) {
        completionRef.current.close()
        hintsRef.current.close()
        setClaudeMode(true)
      }
      return true
    },
    insertPaths,
    removeToken: (id) => {
      const d = docRef.current
      const pos = tokenPos(d, id)
      if (pos < 0) return false
      apply({ ...splice(d, pos, pos + 1, ''), selected: null })
      nav.current = NAV_START
      report()
      return true
    },
    note: showNote,
    snapshot: () => ({ doc: docRef.current, claude: claudeRef.current }),
    restore: (snap) => {
      completionRef.current.close()
      hintsRef.current.close()
      setAt(null)
      setClaudeMode(snap.claude)
      nav.current = NAV_START
      setDoc(snap.doc, snap.doc.text.length)
    },
    load: (d) => {
      if (props.current.disabled) return false
      completionRef.current.close()
      hintsRef.current.close()
      setAt(null)
      setClaudeMode(true)
      nav.current = NAV_START
      setDoc(d, d.text.length)
      edRef.current?.focus()
      return true
    },
  }))

  /** `@…` у курсора (режим Claude): выбор с группами; esc закрывает его до правки строки. */
  function updateAt(v: string | null, cursor: number) {
    if (v === null || !claudeRef.current) return setAt(null)
    const key = `${cursor};${v}`
    if (atDismissed.current !== null) {
      if (atDismissed.current === key) return setAt(null)
      atDismissed.current = null
    }
    const lineStart = v.lastIndexOf('\n', cursor - 1) + 1
    const nl = v.indexOf('\n', cursor)
    const text = v.slice(lineStart, nl < 0 ? v.length : nl)
    const ctx = atContext(text, [...v.slice(lineStart, cursor)].length)
    setAt(ctx ? { ctx, lineStart } : null)
  }

  /** Строка выбора `@` → значок вместо набранного `@…`. tab — ⇥: папка открывается, а не вставляется. */
  function pickAt(i: number, tab: boolean) {
    const r = atRowsRef.current[i]
    if (!r) return
    if (r.group === 'files') {
      if (r.entry.isDir && !tab) completionRef.current.insertAt(r.index)
      else completionRef.current.pick(r.index)
      return
    }
    const a = atRef.current
    if (!a) return
    const tok = r.group === 'blocks' ? blockAttachment(r.block) : messageAttachment(r.text, r.agent, r.id)
    const from = a.lineStart + a.ctx.tokenStart
    completionRef.current.close()
    setAt(null)
    apply(insertTokens(splice(docRef.current, from, from + a.ctx.token.length, '').doc, { start: from, end: from }, [tok]))
  }

  function atKey(e: KeyboardEvent): boolean {
    const rows = atRowsRef.current
    if (rows.length === 0 || e.isComposing || e.keyCode === 229) return false
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false
    const n = rows.length
    const i = Math.min(atSelRef.current, n - 1)
    switch (e.key) {
      case 'ArrowDown':
        setAtSel((i + 1) % n)
        return true
      case 'ArrowUp':
        setAtSel((i - 1 + n) % n)
        return true
      case 'Enter':
        pickAt(i, false)
        return true
      case 'Tab':
        pickAt(i, true)
        return true
      case 'Escape': {
        const el = edRef.current
        const s = el ? getSelection(el) : null
        atDismissed.current = `${s?.end ?? docRef.current.text.length};${docRef.current.text}`
        completionRef.current.close()
        setAt(null)
        return true
      }
      default:
        return false
    }
  }

  function report() {
    const el = edRef.current
    if (!el) return
    const v = docRef.current.text
    const cursor = (document.activeElement === el ? getSelection(el)?.end : null) ?? v.length
    const q = props.current
    if (q.answer) return setAt(null)
    if (q.hints && !q.disabled && !q.continuation) hintsRef.current.update(v, cursor)
    const allowed = claudeRef.current ? (q.atFiles ?? q.completions) : q.completions
    updateAt(allowed && !q.disabled ? v : null, cursor)
    if (!allowed) return
    completionRef.current.update(v, cursor)
  }

  // Курсор двигается (мышь, стрелки) — подсказки по новому месту.
  useEffect(() => {
    const onSel = () => {
      const el = edRef.current
      if (el && document.activeElement === el) {
        report()
        syncNear()
      }
    }
    document.addEventListener('selectionchange', onSel)
    return () => document.removeEventListener('selectionchange', onSel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Набор браузером (буквы, IME): модель — из DOM, поле не перерисовываем. */
  const onInput = () => {
    const el = edRef.current
    if (!el) return
    const d = readDoc(el, docRef.current.tokens)
    if (selTok.current) {
      el.querySelector('.tk.sel')?.classList.remove('sel')
      selTok.current = null
    }
    if (d.tokens.length > 0) lastTokens.current = d.tokens
    docRef.current = d
    setDocState(d)
    // Правка строки — выход из истории: ↑ снова начнёт с последней команды.
    nav.current = NAV_START
    report()
    syncNear()
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    const ne = e.nativeEvent
    // Выключенная строка (идёт команда) клавиш не обрабатывает — как выключенная textarea.
    // ⌘-сочетания (копирование выделения) остаются браузеру; хоткеи приложения ловит окно раньше.
    if (props.current.disabled) {
      if (!e.metaKey) e.preventDefault()
      return
    }
    // Карточка выбора модели забирает клавиши (кроме сочетаний с модификаторами).
    const pk = pickerRef.current
    if (pk && !ne.isComposing && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault()
      const r = pickerKey(pk, e.key)
      if (r.action?.kind === 'cancel') setPickerState(null)
      else if (r.action?.kind === 'choose') {
        setPickerState(null)
        const { alias, effort, persist } = r.action
        props.current.onChooseModel?.({ alias, effort, persist })
      } else if (r.handled) setPickerState(r.state)
      return
    }
    if (pk && e.ctrlKey && e.key.toLowerCase() === 'c') {
      e.preventDefault()
      setPickerState(null)
      return
    }
    // Режим Claude: `@` — выбор с группами (файлы, блоки, сообщения), иначе — подсказки путей.
    if ((claudeRef.current ? atKey(ne) : completionRef.current.onKey(ne)) || hintsRef.current.onKey(ne)) {
      e.preventDefault()
      return
    }
    // Tab/⇧Tab не уводят фокус из строки ввода (в спрятанный xterm или по кнопкам окна).
    if (e.key === 'Tab') {
      e.preventDefault()
      return
    }
    if (ne.isComposing || ne.keyCode === 229) return
    const pv = props.current.preview
    // ␣ у значка — мини-просмотр (повторный ␣ закрывает); не у значка — обычный пробел.
    if (e.key === ' ' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && pv && claudeRef.current) {
      const t = nearToken()
      const tel = t ? el.querySelector<HTMLElement>(`[data-tk="${t.id}"]`) : null
      if (t && tel) {
        e.preventDefault()
        pv.toggle(effective(t, overBudget(docRef.current.tokens)), tel, 'input')
        return
      }
    }
    // Открытый просмотр: ↵ / ⌘↵ / ⌫ / esc / ←→ (страницы PDF) — его.
    if (pv?.key(ne)) {
      e.preventDefault()
      return
    }
    const d = docRef.current
    const v = d.text
    const sel = getSelection(el) ?? { start: v.length, end: v.length }
    const plain = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey
    const mods = { meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey }
    const only = (m: keyof typeof mods | null) =>
      (Object.keys(mods) as (keyof typeof mods)[]).every((k) => mods[k] === (k === m))

    // E в пустой строке при выбранном (⌘↑) сообщении «Вы» — изменить его.
    if (e.code === 'KeyE' && plain && v === '' && !props.current.answer && !props.current.edit && props.current.onEditSelected?.()) {
      e.preventDefault()
      return
    }
    // ⌫/⌦: значок сначала выделяется, вторым нажатием удаляется; буквы — по графемам.
    if ((e.key === 'Backspace' || e.key === 'Delete') && plain) {
      e.preventDefault()
      const r = (e.key === 'Backspace' ? backspace : forwardDelete)(d, sel, selTok.current)
      if (r.doc === d && r.selected === selTok.current && r.caret === sel.start) return
      apply(r)
      if (r.doc !== d) {
        nav.current = NAV_START
        report()
      }
      return
    }
    // ←/→: значок — как одна буква.
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && plain) {
      e.preventDefault()
      const dir = e.key === 'ArrowLeft' ? -1 : 1
      const to = sel.start !== sel.end ? (dir < 0 ? sel.start : sel.end) : moveCaret(v, sel.start, dir)
      if (selTok.current) {
        el.querySelector('.tk.sel')?.classList.remove('sel')
        selTok.current = null
      }
      setSelection(el, to)
      syncNear()
      return
    }
    if (selTok.current && !['Shift', 'Meta', 'Control', 'Alt'].includes(e.key)) {
      el.querySelector('.tk.sel')?.classList.remove('sel')
      selTok.current = null
    }
    // ⌘O — системный диалог файлов.
    if (only('meta') && e.code === 'KeyO') {
      e.preventDefault()
      openDialog()
      return
    }
    // Правка сообщения: esc — отмена (строка вернётся к черновику), набранное правкой не уходит.
    if (e.key === 'Escape' && plain && props.current.edit && !props.current.answer) {
      e.preventDefault()
      props.current.edit.onCancel()
      return
    }
    // Пауза очереди: esc сначала убирает подсказку (режим Claude остаётся).
    if (e.key === 'Escape' && plain && !props.current.answer && v === '' && props.current.queue?.dismissHint()) {
      e.preventDefault()
      return
    }
    // Свой ответ на вопрос агента: esc — назад к вопросу (набранное остаётся).
    if (e.key === 'Escape' && props.current.answer && plain) {
      e.preventDefault()
      props.current.answer.onCancel()
      return
    }
    // esc на пустой строке — выход из режима Claude (сессия продолжает жить).
    if (e.key === 'Escape' && claudeRef.current && v === '' && plain) {
      e.preventDefault()
      setClaudeMode(false)
      hintsRef.current.reset()
      return
    }

    if (e.key === 'Enter') {
      // Поле само строк не вставляет (иначе браузер добавит <div>).
      e.preventDefault()
      if (only('shift')) {
        apply(insertText(d, sel, '\n'))
        nav.current = NAV_START
        report()
        return
      }
      if (only('meta')) {
        if (v.trim()) submit(v, true)
        return
      }
      if (only(null)) {
        if (v.trim()) submit(v, false)
        else if (v === '' && !props.current.answer && !props.current.edit) props.current.queue?.sendNext()
      }
      return
    }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && only(null)) {
      const up = e.key === 'ArrowUp'
      // ↑ в пустой строке — последнее сообщение очереди Claude обратно в строку (для правки).
      if (up && v === '' && !props.current.answer && !props.current.edit) {
        const r = props.current.queue?.recall() ?? null
        if (r !== null) {
          e.preventDefault()
          nav.current = NAV_START
          const back = typeof r === 'string' ? docOf(r) : docOf(r.text, r.tokens)
          setDoc(back, back.text.length)
          return
        }
        // Очередь пуста — ↑ в режиме Claude правит последнее отправленное сообщение.
        if (claudeRef.current && props.current.onEditLast?.()) {
          e.preventDefault()
          return
        }
      }
      if (sel.start !== sel.end) return
      const pos = sel.start
      if (up ? !onFirstLine(v, pos) : !onLastLine(v, pos)) return
      const step = historyStep(getHistory(), nav.current, v, up ? 'up' : 'down')
      if (!step) return
      e.preventDefault()
      nav.current = step.nav
      setLine(step.value, step.value.length)
      completionRef.current.update(step.value, step.value.length, false)
      hintsRef.current.update(step.value, step.value.length, false)
      return
    }
    if (only('ctrl') && e.key.toLowerCase() === 'c') {
      e.preventDefault()
      if (props.current.onInterrupt(v === '', claudeRef.current)) return
      nav.current = NAV_START
      completionRef.current.close()
      hintsRef.current.close()
      lastTokens.current = []
      setLine('', 0)
      return
    }
    if (only('ctrl') && e.key.toLowerCase() === 'd' && v === '') {
      e.preventDefault()
      props.current.onEof?.()
      return
    }
    if (only('ctrl') && e.key.toLowerCase() === 'l') {
      e.preventDefault()
      props.current.onClearFeed()
    }
  }

  const onPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault()
    if (props.current.disabled) return
    const cd = e.clipboardData
    const text = cd?.getData('text/plain') ?? ''
    if (text) {
      putText(text)
      return
    }
    const types = Array.from(cd?.types ?? [])
    const items = Array.from(cd?.items ?? [])
    const image = types.some((t) => t === 'Files' || t.startsWith('image/')) || items.some((i) => i.type.startsWith('image/'))
    if (!image) return
    // Картинка из буфера (скриншот): Rust сохраняет PNG в attachments/ — значок «скрин».
    pasteClipboardImage()
      .then((info) => {
        if (!info) return
        if (!acceptsTokens()) return putText(shellEscape(info.path))
        putTokens([pathAttachment(info, screenshotLabel(docRef.current.tokens))])
      })
      .catch((err: unknown) => showNote(`Картинка не вставлена: ${String(err)}`))
  }

  const onCopy = (e: React.ClipboardEvent<HTMLDivElement>, cut: boolean) => {
    const el = edRef.current
    const sel = el ? getSelection(el) : null
    if (!sel || sel.start === sel.end) return
    e.preventDefault()
    e.clipboardData.setData('text/plain', readable(docRef.current, sel.start, sel.end))
    if (cut) apply(insertText(docRef.current, sel, ''))
  }

  // Выбор `@` (режим Claude): файлы из подсказок путей + блоки и сообщения ленты.
  const cs = completion.state
  const atFilesList = at && cs.open && cs.ctx?.command === AT_COMMAND ? cs.items : null
  const atOn = claudeMode && !!at && pathsOn && !p.disabled && !p.answer
  const rows = useMemo<AtRow[]>(
    () => (atOn && at ? atRows(at.ctx.namePart, at.ctx.dirPart, atFilesList ?? [], props.current.atFeed?.() ?? null) : []),
    [atOn, at, atFilesList],
  )
  const atRowsRef = useRef<AtRow[]>([])
  useEffect(() => {
    atRowsRef.current = rows
  })
  const rowsKey = rows.map((r) => r.key).join('\n')
  useEffect(() => {
    setAtSel(0)
  }, [rowsKey, setAtSel])
  const [atWide, setAtWide] = useState(true)
  const atShown = rows.length > 0
  useLayoutEffect(() => {
    if (!atShown) return
    const w = wrapRef.current?.clientWidth ?? 0
    // В jsdom размеров нет — просмотр не прячем.
    setAtWide(w === 0 || w >= AT_SIDE_MIN)
  }, [atShown])

  // Попап — над полем, у начала подставляемого токена.
  const { open, ctx, items, buffer, lineStart } = completion.state
  const [popupX, setPopupX] = useState(0)
  const [avail, setAvail] = useState(0)
  useLayoutEffect(() => {
    if (!open || !ctx) return
    const m = measureRef.current
    const el = edRef.current
    const wrap = wrapRef.current
    const wrapLeft = wrap?.getBoundingClientRect().left ?? 0
    let x: number
    const r = el ? document.createRange() : null
    let rect: DOMRect | null = null
    if (el && r && typeof r.getBoundingClientRect === 'function') {
      const pt = domPoint(el, lineStart + ctx.tokenStart)
      r.setStart(pt.node, pt.offset)
      r.collapse(true)
      rect = r.getBoundingClientRect()
    }
    if (rect && (rect.left !== 0 || rect.width !== 0)) x = rect.left - wrapLeft
    else {
      if (m) m.textContent = buffer.slice(lineStart, lineStart + ctx.tokenStart)
      const left = el && wrap ? el.getBoundingClientRect().left - wrapLeft : 0
      x = left + (m?.offsetWidth ?? 0)
    }
    const width = wrap?.clientWidth ?? 0
    setAvail(width)
    setPopupX(width > 0 ? Math.max(0, Math.min(x, width - LIST_WIDTH)) : x)
  }, [open, ctx, buffer, lineStart])

  const empty = doc.text === ''
  const placeholder = p.answer ? ANSWER_PLACEHOLDER : p.edit ? EDIT_PLACEHOLDER : claudeMode ? CLAUDE_PLACEHOLDER : PLACEHOLDER
  return (
    <div className="input-wrap" ref={wrapRef}>
      {atShown && (
        <AtPicker
          rows={rows}
          selected={Math.min(atSel, rows.length - 1)}
          query={at?.ctx.namePart ?? ''}
          dirPart={at?.ctx.dirPart ?? ''}
          dir={cs.dir}
          side={atWide}
          cwd={p.cwd()}
          home={p.home ?? undefined}
          onSelect={setAtSel}
          onPick={(i) => pickAt(i, false)}
        />
      )}
      {!claudeMode && open && ctx && pathsOn && !p.disabled && (
        <CompletionPopup
          state={completion.state}
          x={popupX}
          y={-(popupHeight(items.length) + POPUP_GAP)}
          // В jsdom размеров нет — превью не прячем.
          previewFits={avail === 0 || popupX + LIST_WIDTH + PREVIEW_WIDTH <= avail}
          onPick={completion.pick}
        />
      )}
      {picker && !p.disabled && (
        <ModelPicker
          state={picker}
          current={p.modelInfo?.().current ?? 'default'}
          onSelect={(i) => setPickerState({ ...picker, selected: i })}
        />
      )}
      {!picker && hints.state.open && p.hints && !p.disabled && !p.continuation && (
        <HintsPopup state={hints.state} onPick={hints.pick} />
      )}
      {p.continuation && !p.disabled && <div className="in-note">{CONTINUATION_NOTE}</div>}
      {note && !p.continuation && <div className="in-note">{note}</div>}
      <div className={'input' + (p.disabled ? ' off' : '')} onMouseDown={(e) => {
        // Клик по рамке/подсказке — фокус в поле.
        if (!edRef.current?.contains(e.target as Node)) {
          e.preventDefault()
          if (!p.disabled) edRef.current?.focus()
        }
      }}>
        <button
          type="button"
          className="clip"
          aria-label={CLIP_LABEL}
          title={CLIP_LABEL}
          tabIndex={-1}
          disabled={p.disabled}
          onMouseDown={(e) => e.preventDefault()}
          onClick={openDialog}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path d={CLIP_PATH} fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
        </button>
        {claudeMode && (
          <span className="in-mode" aria-hidden="true">
            {CLAUDE_MARK}
          </span>
        )}
        <div className="in-field">
          <div
            ref={edRef}
            className={'in-ta' + (empty ? ' empty' : '')}
            role="textbox"
            aria-multiline="true"
            aria-label={placeholder}
            aria-disabled={p.disabled || undefined}
            contentEditable={p.disabled ? false : 'plaintext-only'}
            tabIndex={p.disabled ? -1 : 0}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onInput={onInput}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onCopy={(e) => onCopy(e, false)}
            onCut={(e) => onCopy(e, true)}
            onDrop={(e) => e.preventDefault()}
            onMouseOver={(e) => {
              // Наведение на значок — мини-просмотр (с задержкой, см. usePreview).
              const tk = (e.target as HTMLElement).closest?.('[data-tk]') as HTMLElement | null
              const t = tk ? docRef.current.tokens.find((x) => x.id === tk.dataset.tk) : undefined
              if (tk && t && !props.current.disabled) props.current.preview?.hover(effective(t, overBudget(docRef.current.tokens)), tk, 'input')
            }}
            onMouseOut={(e) => {
              const tk = (e.target as HTMLElement).closest?.('[data-tk]') as HTMLElement | null
              if (tk && !tk.contains(e.relatedTarget as Node | null)) props.current.preview?.leave()
            }}
            onMouseDown={(e) => {
              // Клик по значку — выделить его (⌫ удалит), курсор — после значка.
              const tk = (e.target as HTMLElement).closest?.('[data-tk]') as HTMLElement | null
              if (!tk || !edRef.current) return
              e.preventDefault()
              const id = tk.dataset.tk!
              const pos = tokenPos(docRef.current, id)
              if (pos < 0) return
              edRef.current.focus()
              setDoc(docRef.current, pos + 1, id)
            }}
            onFocus={() => {
              // Клик по выключенной строке фокус не берёт (как выключенная textarea).
              if (props.current.disabled) {
                edRef.current?.blur()
                return
              }
              setFocused(true)
              const el = edRef.current
              if (el && savedCursor.current !== null) {
                setSelection(el, Math.min(savedCursor.current, docRef.current.text.length))
                savedCursor.current = null
              }
            }}
            onBlur={() => {
              const el = edRef.current
              const s = el ? getSelection(el) : null
              savedCursor.current = s ? s.end : null
              setFocused(false)
              setNearTok(false)
              setAt(null)
              completionRef.current.close()
              hintsRef.current.close()
              setPickerState(null)
            }}
          />
          {empty && (
            <span className="ph" aria-hidden="true">
              {placeholder}
              {focused && !p.disabled && <span className="caret" />}
            </span>
          )}
          <span className="in-measure" ref={measureRef} aria-hidden="true" />
        </div>
        <span className="in-hint">{p.answer ? ANSWER_HINT : nearTok && claudeMode ? PREVIEW_HINT : p.edit ? EDIT_HINT : claudeMode ? CLAUDE_HINT : ASK_HINT}</span>
      </div>
    </div>
  )
})

export default InputBar
