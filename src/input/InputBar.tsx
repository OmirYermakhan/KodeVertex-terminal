// Строка ввода панели (как в Warp, макет 04-main-window `.input`): ↵ — команда в оболочку,
// ⌘↵ — вопрос Claude, ↑/↓ — история, подсказки путей — попап над полем.
// `claude` ↵ — режим Claude: ↵ шлёт вопросы агенту, `/exit`, `exit` или esc на пустой строке — выход.
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import { useCompletion } from '../completion/useCompletion'
import { CompletionPopup, LIST_WIDTH, PREVIEW_WIDTH, popupHeight } from '../completion/CompletionPopup'
import { useHints } from '../completion/useHints'
import { HintsPopup } from '../completion/HintsPopup'
import { isClaudeExit, isModelCommand, parseClaudeCommand } from './claudeCommand'
import { ModelPicker } from '../claude/ModelPicker'
import { initialPicker, pickerKey, type ModelChoice, type PickerState } from '../claude/models'
import { getHistory, historyStep, loadHistory, NAV_START, pushHistory, type HistoryNav } from './history'

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
export const CONTINUATION_NOTE = 'Команда не закончена — допишите или ⌃C'

export interface InputBarProps {
  /** Идёт shell-команда: строка неактивна, ввод — в живом терминале. */
  disabled: boolean
  /** Подсказки путей разрешены (панель в фокусе, настройки закрыты, включены в настройках). */
  completions: boolean
  /** Выборка `claude …` / `/…` разрешена (панель в фокусе, настройки закрыты). */
  hints?: boolean
  cwd: () => string | undefined
  home: string | null
  /** Оболочка ждёт продолжения команды (PS2): над полем подсказка. */
  continuation?: boolean
  /** ↵: команда в оболочку; false — не отправлена (оболочка не готова), строка остаётся. */
  onRun(cmd: string): boolean
  /** ⌘↵: вопрос в Claude-сессию панели. */
  onAsk(text: string): void
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
  /** ⌃L: очистить ленту. */
  onClearFeed(): void
  /** ⌃D на пустой строке: EOF в оболочку. */
  onEof?(): void
  /** `/model` (режим Claude или ⌘↵): выбор модели. Нет — `/model` уходит вопросом. */
  onChooseModel?(choice: ModelChoice): void
  /** Текущие модель (псевдоним, null — по умолчанию) и усилие панели — для карточки выбора. */
  modelInfo?(): { current: string | null; effort: string | null }
  /** «Свой ответ…» на вопрос агента: ↵ отдаёт текст сюда, esc — назад к вопросу. */
  answer?: { onSubmit(text: string): void; onCancel(): void } | null
}

export interface InputBarHandle {
  focus(): void
  /** Фокус сейчас в поле. */
  hasFocus(): boolean
  /** В поле ничего не набрано. */
  isEmpty(): boolean
  /** Открыта карточка выбора модели (`/model`). */
  pickerOpen(): boolean
}

const onFirstLine = (v: string, pos: number) => !v.slice(0, pos).includes('\n')
const onLastLine = (v: string, pos: number) => !v.slice(pos).includes('\n')

export const InputBar = forwardRef<InputBarHandle, InputBarProps>(function InputBar(p, ref) {
  const taRef = useRef<HTMLTextAreaElement>(null)
  const measureRef = useRef<HTMLSpanElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [value, setValue] = useState('')
  const [focused, setFocused] = useState(false)
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
  /** Курсор, который надо выставить после рендера нового значения. */
  const pendingCursor = useRef<number | null>(null)
  const nav = useRef<HistoryNav>(NAV_START)
  const props = useRef(p)
  useEffect(() => {
    props.current = p
  })

  useImperativeHandle(ref, () => ({
    focus: () => taRef.current?.focus(),
    hasFocus: () => !!taRef.current && document.activeElement === taRef.current,
    isEmpty: () => (taRef.current?.value ?? '') === '',
    pickerOpen: () => pickerRef.current !== null,
  }))

  useEffect(() => {
    void loadHistory()
  }, [])

  const setLine = useCallback((v: string, cursor: number) => {
    pendingCursor.current = cursor
    setValue(v)
  }, [])

  const submit = useCallback((text: string, ask: boolean) => {
    const q = props.current
    if (q.answer) {
      q.answer.onSubmit(text.trim())
    } else if ((ask || claudeRef.current) && isModelCommand(text) && q.onChooseModel) {
      const info = q.modelInfo?.() ?? { current: null, effort: null }
      completionRef.current.close()
      hintsRef.current.close()
      setPickerState(initialPicker(info.current, info.effort))
    } else if (claudeRef.current && isClaudeExit(text)) {
      setClaudeMode(false)
    } else if (ask || claudeRef.current) {
      props.current.onAsk(text)
    } else {
      // Продолжение незаконченной команды (PS2) — это не команда `claude`.
      const c = props.current.continuation ? { kind: 'shell' as const, cmd: text } : parseClaudeCommand(text)
      if (c.kind === 'shell') {
        if (!props.current.onRun(c.cmd)) {
          setLine(text, text.length)
          return
        }
      } else {
        completionRef.current.close()
        if (props.current.onEnterClaude(c.kind === 'ask' ? c.text : undefined)) setClaudeMode(true)
      }
      pushHistory(text)
    }
    nav.current = NAV_START
    setLine('', 0)
    completionRef.current.reset()
    hintsRef.current.reset()
  }, [setLine, setClaudeMode, setPickerState])

  const completion = useCompletion({
    cwd: () => props.current.cwd(),
    home: p.home,
    replace: (v, cursor, run) => {
      if (run) return submit(v, false)
      setLine(v, cursor)
      // Подставили каталог — сразу показать его содержимое.
      completionRef.current.update(v, cursor)
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
  useEffect(() => {
    if (!p.completions || p.disabled) completionRef.current.close()
  }, [p.completions, p.disabled])

  useLayoutEffect(() => {
    const ta = taRef.current
    if (!ta) return
    if (pendingCursor.current !== null) {
      ta.setSelectionRange(pendingCursor.current, pendingCursor.current)
      pendingCursor.current = null
    }
    // Авто-высота: по содержимому, не выше MAX_ROWS строк.
    ta.style.height = 'auto'
    const lh = parseFloat(getComputedStyle(ta).lineHeight)
    const max = Number.isFinite(lh) ? lh * MAX_ROWS : Infinity
    if (ta.scrollHeight > 0) ta.style.height = `${Math.min(ta.scrollHeight, max)}px`
  }, [value])

  const report = (ta: HTMLTextAreaElement) => {
    const cursor = ta.selectionStart ?? ta.value.length
    const q = props.current
    if (q.answer) return
    if (q.hints && !q.disabled && !q.continuation) hintsRef.current.update(ta.value, cursor)
    if (!q.completions || claudeRef.current) return
    completionRef.current.update(ta.value, cursor)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget
    const ne = e.nativeEvent
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
    if (completionRef.current.onKey(ne) || hintsRef.current.onKey(ne)) {
      e.preventDefault()
      return
    }
    // Tab/⇧Tab не уводят фокус из строки ввода (в спрятанный xterm или по кнопкам окна).
    if (e.key === 'Tab') {
      e.preventDefault()
      return
    }
    if (ne.isComposing || ne.keyCode === 229) return
    const v = ta.value
    // Свой ответ на вопрос агента: esc — назад к вопросу (набранное остаётся).
    if (e.key === 'Escape' && props.current.answer && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      e.preventDefault()
      props.current.answer.onCancel()
      return
    }
    // esc на пустой строке — выход из режима Claude (сессия продолжает жить).
    if (e.key === 'Escape' && claudeRef.current && v === '' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      e.preventDefault()
      setClaudeMode(false)
      hintsRef.current.reset()
      return
    }
    const mods = { meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey }
    const only = (m: keyof typeof mods | null) =>
      (Object.keys(mods) as (keyof typeof mods)[]).every((k) => mods[k] === (k === m))

    if (e.key === 'Enter') {
      if (only('shift')) return // ⇧↵ — новая строка (поведение поля по умолчанию)
      if (only('meta')) {
        e.preventDefault()
        if (v.trim()) submit(v, true)
        return
      }
      if (only(null)) {
        e.preventDefault()
        if (v.trim()) submit(v, false)
      }
      return
    }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && only(null)) {
      const up = e.key === 'ArrowUp'
      if (ta.selectionStart !== ta.selectionEnd) return
      const pos = ta.selectionStart
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

  // Попап — над полем, у начала подставляемого токена.
  const { open, ctx, items, buffer, lineStart } = completion.state
  const [popupX, setPopupX] = useState(0)
  const [avail, setAvail] = useState(0)
  useLayoutEffect(() => {
    if (!open || !ctx) return
    const m = measureRef.current
    const ta = taRef.current
    const wrap = wrapRef.current
    if (m) m.textContent = buffer.slice(lineStart, lineStart + ctx.tokenStart)
    const left = ta && wrap ? ta.getBoundingClientRect().left - wrap.getBoundingClientRect().left : 0
    const width = wrap?.clientWidth ?? 0
    const x = left + (m?.offsetWidth ?? 0)
    setAvail(width)
    setPopupX(width > 0 ? Math.max(0, Math.min(x, width - LIST_WIDTH)) : x)
  }, [open, ctx, buffer, lineStart])

  const empty = value === ''
  const placeholder = p.answer ? ANSWER_PLACEHOLDER : claudeMode ? CLAUDE_PLACEHOLDER : PLACEHOLDER
  return (
    <div className="input-wrap" ref={wrapRef}>
      {open && ctx && p.completions && !p.disabled && !claudeMode && (
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
      <div className={'input' + (p.disabled ? ' off' : '')} onMouseDown={(e) => {
        // Клик по рамке/подсказке — фокус в поле.
        if (e.target !== taRef.current) {
          e.preventDefault()
          taRef.current?.focus()
        }
      }}>
        {claudeMode && (
          <span className="in-mode" aria-hidden="true">
            {CLAUDE_MARK}
          </span>
        )}
        <div className="in-field">
          <textarea
            ref={taRef}
            className={'in-ta' + (empty ? ' empty' : '')}
            value={value}
            rows={Math.min(MAX_ROWS, value.split('\n').length)}
            disabled={p.disabled}
            aria-label={placeholder}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            onChange={(e) => {
              // Правка строки — выход из истории: ↑ снова начнёт с последней команды.
              nav.current = NAV_START
              setValue(e.target.value)
              report(e.target)
            }}
            onSelect={(e) => report(e.currentTarget)}
            onKeyDown={onKeyDown}
            onFocus={() => setFocused(true)}
            onBlur={() => {
              setFocused(false)
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
        <span className="in-hint">{p.answer ? ANSWER_HINT : claudeMode ? CLAUDE_HINT : ASK_HINT}</span>
      </div>
    </div>
  )
})

export default InputBar
