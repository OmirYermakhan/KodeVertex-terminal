// Вопрос агента (AskUserQuestion) над строкой ввода: варианты с описанием и меткой «рекомендуется»,
// «Свой ответ…» (поле ввода прямо в строке; любая буква после ARM_MS — сразу туда). Несколько вопросов — вкладки «1 из 3» (←/→) и шаг
// «Отправить ответы». Клавиши: ↑↓/1–9 выбор, пробел — отметить (несколько ответов), ↵, esc — к вводу.
import { forwardRef, useEffect, useRef, useState } from 'react'
import { AgentPrompt } from './AgentPrompt'
import { ARM_MS } from './PermissionPrompt'
import { agentSignature } from './cards/AssistantCard'
import { displayLabel, isRecommended, questionKey, type QuestionCursor } from './questions'
import { questionSteps, type Agent, type FeedClaudeItem } from './reducer'

type QuestionItem = Extract<FeedClaudeItem, { type: 'question' }>

export const OWN_ANSWER = 'Свой ответ…'
export const SEND_ANSWERS = 'Отправить ответы'
export const RECOMMENDED_TAG = 'рекомендуется'

export interface QuestionPromptProps {
  item: QuestionItem
  agent?: Agent
  onAnswer(index: number, text: string): void
  onStep(step: number): void
  onSubmit(): void
  onLeave(): void
}

export function promptKeys(multiStep: boolean, multiSelect: boolean, sendStep: boolean): string {
  if (sendStep) return ['↑↓ выбрать', '←/→ вопросы', '↵ отправить', 'esc к вводу'].join(' · ')
  return [
    '↑↓ 1–9 выбрать',
    ...(multiSelect ? ['пробел отметить'] : []),
    '↵ ответить',
    ...(multiStep ? ['←/→ вопросы'] : []),
    'esc к вводу',
  ].join(' · ')
}

export const QuestionPrompt = forwardRef<HTMLDivElement, QuestionPromptProps>(function QuestionPrompt(p, ref) {
  const { item } = p
  const total = item.questions.length
  const steps = questionSteps(item)
  const sendStep = steps > 1 && item.step === steps - 1
  const q = item.questions[Math.min(item.step, total - 1)]
  const [cur, setCur] = useState<QuestionCursor>({ cursor: 0, checked: [] })
  /** Набранный «свой ответ» по вопросам (не теряется при переходе между вкладками). */
  const [own, setOwn] = useState<Record<number, string>>({})
  const ownRef = useRef<HTMLInputElement>(null)
  const ownRow = !sendStep && cur.cursor === q.options.length
  const ownText = own[item.step] ?? ''
  const setOwnText = (t: string) => setOwn((o) => ({ ...o, [item.step]: t }))
  useEffect(() => setOwn({}), [item.requestId])
  // Как у разрешения: первые ARM_MS после появления вопроса ↵ и щелчок по варианту не отвечают —
  // ↵, нажатый ради строки ввода в момент, когда вопрос забрал фокус, не должен выбрать вариант.
  // Блок не пересоздаётся на каждый вопрос — отсчёт заново по requestId. Своего ответа это тоже
  // касается: буквы, набранные ради строки ввода, пока вопрос забирал фокус, — в строку, а не в ответ.
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    setArmed(false)
    const t = setTimeout(() => setArmed(true), ARM_MS)
    return () => clearTimeout(t)
  }, [item.requestId])
  // Новая вкладка: курсор — на прежний ответ (если был), на шаге отправки — на «Отправить ответы».
  // Прежний ответ не из вариантов — это свой ответ: курсор на поле, текст в нём.
  useEffect(() => {
    if (sendStep) return setCur({ cursor: total, checked: [] })
    const answer = item.answers[item.step] ?? ''
    const prev = answer.split(', ')
    const checked = q.options.map((o, i) => (prev.includes(o.label) ? i : -1)).filter((i) => i >= 0)
    if (answer && checked.length === 0) {
      setOwn((o) => (o[item.step] ? o : { ...o, [item.step]: answer }))
      return setCur({ cursor: q.options.length, checked: [] })
    }
    setCur({ cursor: checked[0] ?? 0, checked: q.multiSelect ? checked : [] })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.requestId, item.step])
  // Курсор ушёл с «Свой ответ…» — фокус обратно на блок. В поле фокус переходит только по действию
  // пользователя (↑↓/цифра на эту строку, буква, щелчок), не сам по себе (прежний свой ответ на вкладке).
  useEffect(() => {
    const input = ownRef.current
    if (!ownRow && input && document.activeElement === input) input.closest<HTMLElement>('.aprompt')?.focus()
  }, [ownRow, item.step])
  const focusOwn = () => {
    const input = ownRef.current
    if (input && input.closest('.aprompt')?.contains(document.activeElement)) input.focus()
  }

  const submitOwn = () => {
    if (!armed) return
    const text = (ownRef.current?.value ?? ownText).trim()
    if (text) p.onAnswer(item.step, text)
  }
  const onOwnKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.nativeEvent.isComposing) return
    if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      submitOwn()
    } else if (!armed && e.key.length === 1) {
      // Поле получило фокус в первые ARM_MS (щелчок) — набор ещё не ответ: буква уходит в строку ввода.
      e.stopPropagation()
      p.onLeave()
    } else if (
      e.key === 'ArrowUp' ||
      e.key === 'ArrowDown' ||
      e.key === 'Escape' ||
      ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.currentTarget.value)
    ) {
      // ↑↓ — к вариантам, esc — к вводу, ←/→ в пустом поле — вкладки: обработает блок вопроса.
      return
    } else {
      // Остальное (цифры, пробел, ←/→) — набор текста, не клавиши блока.
      e.stopPropagation()
    }
  }

  const firstMissing = item.questions.findIndex((_, i) => !(item.answers[i] ?? ''))

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const handled = () => {
      e.preventDefault()
      e.stopPropagation()
    }
    if (steps > 1 && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      handled()
      p.onStep(Math.max(0, Math.min(steps - 1, item.step + (e.key === 'ArrowLeft' ? -1 : 1))))
      return
    }
    if (e.key === 'Enter' && !armed) {
      handled()
      return
    }
    if (sendStep) {
      const n = total + 1
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        handled()
        setCur({ ...cur, cursor: (cur.cursor + (e.key === 'ArrowDown' ? 1 : n - 1)) % n })
      } else if (/^[1-9]$/.test(e.key) && Number(e.key) <= n) {
        handled()
        setCur({ ...cur, cursor: Number(e.key) - 1 })
      } else if (e.key === 'Enter') {
        handled()
        if (cur.cursor < total) p.onStep(cur.cursor)
        else if (firstMissing >= 0) p.onStep(firstMissing)
        else p.onSubmit()
      } else if (e.key === 'Escape') {
        handled()
        p.onLeave()
      }
      return
    }
    const r = questionKey(cur, q, e.key)
    if (!r.handled) {
      // Буква на любой строке — начало своего ответа: курсор на поле, буква в нём. В первые ARM_MS
      // это набор для строки ввода (вопрос только что забрал фокус): фокус — обратно в строку, без
      // preventDefault — буква попадёт туда же.
      if (e.key.length === 1 && e.target !== ownRef.current) {
        if (!armed) {
          e.stopPropagation()
          p.onLeave()
          return
        }
        handled()
        setOwnText(ownText + e.key)
        setCur({ ...cur, cursor: q.options.length })
        ownRef.current?.focus()
      }
      return
    }
    handled()
    setCur(r.state)
    // ↑↓ или цифра на строку «Свой ответ…» — фокус в поле.
    if (!r.action && r.state.cursor === q.options.length) focusOwn()
    if (r.action?.kind === 'answer') p.onAnswer(item.step, r.action.text)
    else if (r.action?.kind === 'custom') {
      if (ownText.trim()) submitOwn()
      else ownRef.current?.focus()
    } else if (r.action?.kind === 'leave') p.onLeave()
  }

  const pick = (i: number) => {
    setCur({ ...cur, cursor: i })
    if (sendStep) return i < total ? p.onStep(i) : firstMissing >= 0 ? p.onStep(firstMissing) : p.onSubmit()
    const r = questionKey({ ...cur, cursor: i }, q, q.multiSelect && i < q.options.length ? ' ' : 'Enter')
    if (q.multiSelect && i < q.options.length) return setCur({ ...r.state, cursor: i })
    if (r.action?.kind === 'answer') p.onAnswer(item.step, r.action.text)
    else if (r.action?.kind === 'custom') ownRef.current?.focus()
  }
  const row = (i: number, sel: boolean, children: React.ReactNode, extra = '') => (
    <div
      key={i}
      role="option"
      aria-selected={sel}
      className={'q-row' + (sel ? ' sel' : '') + extra}
      aria-disabled={!armed}
      onMouseDown={(e) => {
        // Клик в само поле — ставит каретку как обычно.
        if (e.target === ownRef.current) return setCur({ ...cur, cursor: i })
        // Фокус остаётся, где был; выбор — по отпусканию (click), а не по нажатию.
        e.preventDefault()
      }}
      onClick={(e) => {
        if (e.target === ownRef.current || !armed) return
        pick(i)
      }}
    >
      {children}
    </div>
  )

  return (
    <AgentPrompt
      ref={ref}
      title={`? Вопрос · ${agentSignature(p.agent)}`}
      aside={steps > 1 ? (sendStep ? 'Отправка' : `${Math.min(item.step + 1, total)} из ${total}`) : undefined}
      keys={promptKeys(steps > 1, !sendStep && q.multiSelect, sendStep)}
      label={sendStep ? SEND_ANSWERS : q.question}
      onKeyDown={onKeyDown}
    >
      {steps > 1 && (
        <div className="q-tabs" role="tablist">
          {item.questions.map((x, i) => (
            <span
              key={i}
              role="tab"
              aria-selected={i === item.step}
              className={'q-tab' + (i === item.step ? ' on' : '') + ((item.answers[i] ?? '') ? ' ok' : '')}
              onMouseDown={(e) => {
                e.preventDefault()
                p.onStep(i)
              }}
            >
              {(item.answers[i] ?? '') ? '✓ ' : `${i + 1} `}
              {x.header || x.question}
            </span>
          ))}
          <span
            role="tab"
            aria-selected={sendStep}
            className={'q-tab' + (sendStep ? ' on' : '')}
            onMouseDown={(e) => {
              e.preventDefault()
              p.onStep(steps - 1)
            }}
          >
            {SEND_ANSWERS}
          </span>
        </div>
      )}
      {sendStep ? (
        <div className={'q-opts' + (armed ? '' : ' p-wait')} role="listbox">
          {item.questions.map((x, i) =>
            row(
              i,
              cur.cursor === i,
              <>
                <span className="q-n">{i + 1}.</span>
                <span className="q-l">{x.header || x.question}</span>
                <span className={(item.answers[i] ?? '') ? 'q-d q-given' : 'q-d q-miss'}>{item.answers[i] || 'нет ответа'}</span>
              </>,
            ),
          )}
          {row(
            total,
            cur.cursor === total,
            <>
              <span className="q-n">↵</span>
              <span className="q-l q-send">{SEND_ANSWERS}</span>
              <span className="q-d">{firstMissing >= 0 ? `сначала ответьте на вопрос ${firstMissing + 1}` : ''}</span>
            </>,
          )}
        </div>
      ) : (
        <>
          <div className="q-text">{q.question}</div>
          <div className={'q-opts' + (armed ? '' : ' p-wait')} role="listbox">
            {q.options.map((o, i) =>
              row(
                i,
                i === cur.cursor,
                <>
                  <span className="q-n">{i + 1}.</span>
                  <span className="q-l">
                    {q.multiSelect && <span className="q-box">{cur.checked.includes(i) ? '☑ ' : '☐ '}</span>}
                    {displayLabel(o.label)}
                    {isRecommended(o) && <span className="q-rec">{RECOMMENDED_TAG}</span>}
                  </span>
                  <span className="q-d">{o.description}</span>
                </>,
              ),
            )}
            {row(
              q.options.length,
              cur.cursor === q.options.length,
              <>
                <span className="q-n">{q.options.length + 1}.</span>
                <input
                  ref={ownRef}
                  className="q-l q-own"
                  value={ownText}
                  placeholder={OWN_ANSWER}
                  aria-label={OWN_ANSWER}
                  spellCheck={false}
                  onChange={(e) => setOwnText(e.target.value)}
                  onFocus={() => !ownRow && setCur({ ...cur, cursor: q.options.length })}
                  onKeyDown={onOwnKeyDown}
                />

              </>,
            )}
          </div>
        </>
      )}
    </AgentPrompt>
  )
})

export default QuestionPrompt
