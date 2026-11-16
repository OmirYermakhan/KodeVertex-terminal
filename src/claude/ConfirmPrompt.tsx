// Вопрос «да / нет» над строкой ввода (тот же блок AgentPrompt, что у вопросов и разрешений):
// доверие к папке перед запуском claude, открытие ссылки. Как у разрешения, первые ARM_MS ↵ и
// щелчок не отвечают; esc — «нет».
import { forwardRef, useEffect, useState, type ReactNode } from 'react'
import { AgentPrompt } from './AgentPrompt'
import { ARM_MS } from './PermissionPrompt'
import { neutralize } from './questions'

export const CONFIRM_KEYS = '↑↓ 1–2 выбрать · ↵ ответить · esc — нет'

export interface ConfirmPromptProps {
  /** «? Доверять папке» (моно, заглавные, --warn). */
  title: string
  /** Подпись блока для чтения с экрана. */
  label: string
  yes: string
  no: string
  onAnswer(ok: boolean): void
  children: ReactNode
}

export const ConfirmPrompt = forwardRef<HTMLDivElement, ConfirmPromptProps>(function ConfirmPrompt(p, ref) {
  const opts = [
    { ok: true, label: p.yes },
    { ok: false, label: p.no },
  ]
  const [cur, setCur] = useState(0)
  // Блок монтируется на каждый вопрос (key в TerminalPane): отсчёт — с появления.
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setArmed(true), ARM_MS)
    return () => clearTimeout(t)
  }, [])
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    let handled = true
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') setCur(cur === 0 ? 1 : 0)
    else if (e.key === '1' || e.key === '2') setCur(Number(e.key) - 1)
    else if (e.key === 'Enter') {
      if (armed) p.onAnswer(opts[cur].ok)
    } else if (e.key === 'Escape') p.onAnswer(false)
    else handled = false
    if (handled) {
      e.preventDefault()
      e.stopPropagation()
    }
  }
  return (
    <AgentPrompt ref={ref} title={p.title} keys={CONFIRM_KEYS} label={p.label} onKeyDown={onKeyDown}>
      {p.children}
      <div className={'q-opts' + (armed ? '' : ' p-wait')} role="listbox">
        {opts.map((o, i) => (
          <div
            key={o.label}
            role="option"
            aria-selected={i === cur}
            aria-disabled={!armed}
            className={'q-row' + (i === cur ? ' sel' : '')}
            // Фокус остаётся, где был; ответ — по отпусканию (click), а не по нажатию.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              if (!armed) return
              setCur(i)
              p.onAnswer(o.ok)
            }}
          >
            <span className="q-n">{i + 1}.</span>
            <span className="q-l">{o.label}</span>
            <span className="q-d" />
          </div>
        ))}
      </div>
    </AgentPrompt>
  )
})

/** «? Доверять папке»: claude загрузит из `.claude/` папки настройки, хуки и MCP-серверы. */
export const TrustPrompt = forwardRef<HTMLDivElement, { cwd: string; onAnswer(ok: boolean): void }>(function TrustPrompt(p, ref) {
  return (
    <ConfirmPrompt ref={ref} title="? Доверять папке" label={`Доверять папке ${p.cwd}?`} yes="Доверять" no="Нет" onAnswer={p.onAnswer}>
      <pre className="p-code">{neutralize(p.cwd)}</pre>
      <div className="p-note">
        Claude загрузит из <code>.claude/</code> этой папки настройки, хуки и MCP-серверы и может их запустить. Доверяйте только папкам, в
        содержимом которых уверены.
      </div>
    </ConfirmPrompt>
  )
})

/** Ссылка из ответа или терминала: куда она ведёт — до открытия в браузере. */
export const LinkPrompt = forwardRef<HTMLDivElement, { url: string; host: string; text?: string; onAnswer(ok: boolean): void }>(
  function LinkPrompt(p, ref) {
    return (
      <ConfirmPrompt ref={ref} title="? Открыть ссылку" label={`Открыть ссылку на ${p.host}?`} yes="Открыть" no="Отмена" onAnswer={p.onAnswer}>
        <div className="q-text">
          <code className="p-main">{neutralize(p.host)}</code>
        </div>
        <pre className="p-code">{neutralize(p.url)}</pre>
        {p.text && (
          <div className="p-note p-agent">
            текст ссылки — «{neutralize(p.text)}», но ведёт она на {neutralize(p.host)}
          </div>
        )}
      </ConfirmPrompt>
    )
  },
)

export default ConfirmPrompt
