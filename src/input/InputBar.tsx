// Строка ввода панели (как в Warp, макет 04-main-window `.input`): ↵ — команда в оболочку,
// ⌘↵ — вопрос Claude, ↑/↓ — история, подсказки путей — попап над полем.
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import { useCompletion } from '../completion/useCompletion'
import { CompletionPopup, LIST_WIDTH, PREVIEW_WIDTH, popupHeight } from '../completion/CompletionPopup'
import { getHistory, historyStep, loadHistory, NAV_START, pushHistory, type HistoryNav } from './history'

/** Поле растёт до стольких строк, дальше — прокрутка внутри. */
export const MAX_ROWS = 8
/** Зазор между попапом подсказок и полем, px. */
const POPUP_GAP = 4

export const PLACEHOLDER = 'Команда или вопрос Claude…'
export const ASK_HINT = '⌘↵ отправить агенту'

export interface InputBarProps {
  /** Идёт shell-команда: строка неактивна, ввод — в живом терминале. */
  disabled: boolean
  /** Подсказки путей разрешены (панель в фокусе, настройки закрыты, включены в настройках). */
  completions: boolean
  cwd: () => string | undefined
  home: string | null
  /** ↵: команда в оболочку. */
  onRun(cmd: string): void
  /** ⌘↵: вопрос в Claude-сессию панели. */
  onAsk(text: string): void
  /** ⌃C: true — прерван ход Claude, строку не трогаем; false — строка очищается. */
  onInterrupt(): boolean
  /** ⌃L: очистить ленту. */
  onClearFeed(): void
}

export interface InputBarHandle {
  focus(): void
  /** Фокус сейчас в поле. */
  hasFocus(): boolean
}

const onFirstLine = (v: string, pos: number) => !v.slice(0, pos).includes('\n')
const onLastLine = (v: string, pos: number) => !v.slice(pos).includes('\n')

export const InputBar = forwardRef<InputBarHandle, InputBarProps>(function InputBar(p, ref) {
  const taRef = useRef<HTMLTextAreaElement>(null)
  const measureRef = useRef<HTMLSpanElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [value, setValue] = useState('')
  const [focused, setFocused] = useState(false)
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
  }))

  useEffect(() => {
    void loadHistory()
  }, [])

  const setLine = useCallback((v: string, cursor: number) => {
    pendingCursor.current = cursor
    setValue(v)
  }, [])

  const submit = useCallback((text: string, ask: boolean) => {
    nav.current = NAV_START
    setLine('', 0)
    completionRef.current.reset()
    if (ask) {
      props.current.onAsk(text)
    } else {
      pushHistory(text)
      props.current.onRun(text)
    }
  }, [setLine])

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
    if (!props.current.completions) return
    completionRef.current.update(ta.value, ta.selectionStart ?? ta.value.length)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget
    const ne = e.nativeEvent
    if (completionRef.current.onKey(ne)) {
      e.preventDefault()
      return
    }
    if (ne.isComposing || ne.keyCode === 229) return
    const v = ta.value
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
      return
    }
    if (only('ctrl') && e.key.toLowerCase() === 'c') {
      e.preventDefault()
      if (props.current.onInterrupt()) return
      nav.current = NAV_START
      completionRef.current.close()
      setLine('', 0)
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
  return (
    <div className="input-wrap" ref={wrapRef}>
      {open && ctx && p.completions && !p.disabled && (
        <CompletionPopup
          state={completion.state}
          x={popupX}
          y={-(popupHeight(items.length) + POPUP_GAP)}
          // В jsdom размеров нет — превью не прячем.
          previewFits={avail === 0 || popupX + LIST_WIDTH + PREVIEW_WIDTH <= avail}
          onPick={completion.pick}
        />
      )}
      <div className={'input' + (p.disabled ? ' off' : '')} onMouseDown={(e) => {
        // Клик по рамке/подсказке — фокус в поле.
        if (e.target !== taRef.current) {
          e.preventDefault()
          taRef.current?.focus()
        }
      }}>
        <div className="in-field">
          <textarea
            ref={taRef}
            className={'in-ta' + (empty ? ' empty' : '')}
            value={value}
            rows={Math.min(MAX_ROWS, value.split('\n').length)}
            disabled={p.disabled}
            aria-label={PLACEHOLDER}
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
            }}
          />
          {empty && (
            <span className="ph" aria-hidden="true">
              {PLACEHOLDER}
              {focused && !p.disabled && <span className="caret" />}
            </span>
          )}
          <span className="in-measure" ref={measureRef} aria-hidden="true" />
        </div>
        <span className="in-hint">{ASK_HINT}</span>
      </div>
    </div>
  )
})

export default InputBar
