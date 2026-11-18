// Ответ на побочный вопрос `/btw` (src/claude/btw.ts) — в .dock над строкой ввода, как очередь:
// заголовок .dh, вопрос, ответ markdown. В разговор и ленту не попадает; esc или ✕ — закрыть.
import { Markdown } from './Markdown'
import type { BtwAnswer } from './btw'

export const BTW_KEYS = 'не попадёт в разговор · esc закрыть'

export function BtwCard({ answer, onClose }: { answer: BtwAnswer; onClose(): void }) {
  const run = answer.status === 'run'
  return (
    <div className={'btw' + (answer.status === 'error' ? ' err' : '')} role="region" aria-label="Побочный вопрос" aria-busy={run}>
      <div className="dh">
        <span>
          <b>/btw</b> · побочный вопрос{answer.bare ? ' · без контекста разговора' : ''}
        </span>
        <span className="bt-r">
          <span className="keys">{BTW_KEYS}</span>
          <button type="button" className="qu-x" title="Закрыть (esc)" aria-label="Закрыть" onMouseDown={(e) => e.preventDefault()} onClick={onClose}>
            ✕
          </button>
        </span>
      </div>
      <div className="bt-q">› {answer.question}</div>
      <div className="bt-a">
        {answer.status === 'error' ? (
          <div className="bt-err">{answer.error}</div>
        ) : answer.text === '' ? (
          <div className="thinking" role="status">
            <span className="spin" aria-hidden="true" />
            <span className="th-l">Думает</span>
          </div>
        ) : (
          <Markdown text={answer.text} streaming={run} diagrams={false} />
        )}
      </div>
    </div>
  )
}
