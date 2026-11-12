import { memo } from 'react'
import type { Agent, FeedClaudeItem } from '../reducer'

type Action = Extract<FeedClaudeItem, { type: 'action' }>
export type DiffLine = { k: 'a' | 'd' | 'n'; t: string }

const CONTEXT = 2
const MAX_LINES = 60
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

const split = (s: string): string[] => (s === '' ? [] : s.replace(/\n$/, '').split('\n'))

/** «Было/стало»: общие строки по краям — контекст (не больше CONTEXT), середина — удалено/добавлено. */
export function diffLines(before: string, after: string): DiffLine[] {
  const b = split(before)
  const a = split(after)
  let pre = 0
  while (pre < b.length && pre < a.length && b[pre] === a[pre]) pre++
  let suf = 0
  while (suf < b.length - pre && suf < a.length - pre && b[b.length - 1 - suf] === a[a.length - 1 - suf]) suf++
  const out: DiffLine[] = []
  for (const t of b.slice(Math.max(0, pre - CONTEXT), pre)) out.push({ k: 'n', t })
  for (const t of b.slice(pre, b.length - suf)) out.push({ k: 'd', t })
  for (const t of a.slice(pre, a.length - suf)) out.push({ k: 'a', t })
  for (const t of b.slice(b.length - suf, b.length - suf + CONTEXT)) out.push({ k: 'n', t })
  return out
}

const MARK = { a: '+ ', d: '- ', n: '  ' } as const

function Diff({ before, after }: { before: string; after: string }) {
  const lines = diffLines(before, after)
  const shown = lines.slice(0, MAX_LINES)
  return (
    <div className="diff">
      {shown.map((l, i) => (
        <div key={i} className={l.k}>
          {MARK[l.k] + l.t}
        </div>
      ))}
      {lines.length > shown.length && <span className="n diff-more">… ещё {lines.length - shown.length} строк</span>}
    </div>
  )
}

function shortResult(result: string | undefined): string {
  const line = (result ?? '').split('\n').find((l) => l.trim()) ?? ''
  const t = line.trim()
  return t.length > 80 ? t.slice(0, 79) + '…' : t
}

/** Действие агента (макет 02 B / 04, .act): пунктирная рамка, подпись --info, деталь моноширинным. */
export const ActionCard = memo(function ActionCard({ item, agent, id }: { item: Action; agent: Agent | undefined; id?: string }) {
  const icon = EDIT_TOOLS.has(item.tool) || item.diff ? '✎' : '▶'
  const sub = agent && agent.id !== 'main' ? ` · ${agent.name}` : ''
  const running = item.status === 'running'
  const res = running ? '' : shortResult(item.result)
  const cls = ['act', running && 'run', item.status === 'error' && 'fail'].filter(Boolean).join(' ')
  return (
    <div className={cls} data-item-id={id}>
      <div className="who">
        {icon} {item.title}
        {sub}
      </div>
      {item.detail && <b>{item.detail}</b>}
      {res && (
        <>
          {item.detail && ' · '}
          {res}
        </>
      )}
      {item.diff && <Diff before={item.diff.before} after={item.diff.after} />}
      {running && (
        <div className="act-now">
          <span className="spin" aria-hidden="true" />
          Сейчас выполняю…
        </div>
      )}
    </div>
  )
})
