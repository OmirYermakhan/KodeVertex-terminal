// Вопрос агента (AskUserQuestion) над строкой ввода: варианты с описанием и меткой «рекомендуется»,
// «Свой ответ…» (текст — в строке ввода). Несколько вопросов — вкладки «1 из 3» (←/→) и шаг
// «Отправить ответы». Клавиши: ↑↓/1–9 выбор, пробел — отметить (несколько ответов), ↵, esc — к вводу.
import { forwardRef, useEffect, useState } from 'react'
import { AgentPrompt } from './AgentPrompt'
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
  /** «Свой ответ…» для вопроса index: строка ввода становится полем ответа. */
  onCustom(index: number): void
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
  // Новая вкладка: курсор — на прежний ответ (если был), на шаге отправки — на «Отправить ответы».
  useEffect(() => {
    if (sendStep) return setCur({ cursor: total, checked: [] })
    const prev = (item.answers[item.step] ?? '').split(', ')
    const checked = q.options.map((o, i) => (prev.includes(o.label) ? i : -1)).filter((i) => i >= 0)
    setCur({ cursor: checked[0] ?? 0, checked: q.multiSelect ? checked : [] })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.requestId, item.step])

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
    if (!r.handled) return
    handled()
    setCur(r.state)
    if (r.action?.kind === 'answer') p.onAnswer(item.step, r.action.text)
    else if (r.action?.kind === 'custom') p.onCustom(item.step)
    else if (r.action?.kind === 'leave') p.onLeave()
  }

  const pick = (i: number) => {
    setCur({ ...cur, cursor: i })
    if (sendStep) return i < total ? p.onStep(i) : firstMissing >= 0 ? p.onStep(firstMissing) : p.onSubmit()
    const r = questionKey({ ...cur, cursor: i }, q, q.multiSelect && i < q.options.length ? ' ' : 'Enter')
    if (q.multiSelect && i < q.options.length) return setCur({ ...r.state, cursor: i })
    if (r.action?.kind === 'answer') p.onAnswer(item.step, r.action.text)
    else if (r.action?.kind === 'custom') p.onCustom(item.step)
  }
  const row = (i: number, sel: boolean, children: React.ReactNode, extra = '') => (
    <div
      key={i}
      role="option"
      aria-selected={sel}
      className={'q-row' + (sel ? ' sel' : '') + extra}
      onMouseDown={(e) => {
        e.preventDefault()
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
        <div className="q-opts" role="listbox">
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
          <div className="q-opts" role="listbox">
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
                <span className="q-l q-own">{OWN_ANSWER}</span>
                <span className="q-d" />
              </>,
            )}
          </div>
        </>
      )}
    </AgentPrompt>
  )
})

export default QuestionPrompt
