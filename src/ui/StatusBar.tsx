import { useEffect, useState } from 'react'
import { projectName, useHome, type GitInfo } from '../status/useGitInfo'
import { modelLabel, type ClaudeState } from '../claude/reducer'
import { tokensLabel } from '../claude/AgentsPanel'

/** Доля контекста, после которой полоска желтеет. */
export const CONTEXT_WARN = 0.8

const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`

function useClock(fixed?: Date): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    if (fixed) return
    const t = setInterval(() => setNow(new Date()), 15000)
    return () => clearInterval(t)
  }, [fixed])
  return fixed ?? now
}

// Статус-бар (макет 04-main-window `.sbar`). Сегменты Claude — только при сессии в фокусной панели.
export default function StatusBar(p: { cwd?: string; git: GitInfo | null; now?: Date; claude?: ClaudeState | null }) {
  const home = useHome()
  const now = useClock(p.now)
  const c = p.claude
  const current = c && c.currentAgentId ? c.agents.find((a) => a.id === c.currentAgentId) : undefined
  const share = c && c.contextMax > 0 ? Math.min(1, c.contextUsed / c.contextMax) : 0
  return (
    <div className="sbar">
      {c && <div className="sg v">◆ CLAUDE</div>}
      {current && (
        <div className="sg">
          сейчас <b>{current.name}</b>
        </div>
      )}
      {p.cwd && (
        <div className="sg">
          проект <b>{projectName(p.cwd, p.git, home)}</b>
        </div>
      )}
      {p.git?.branch && (
        <div className="sg">
          ⎇ <b>{p.git.branch}</b>
          {p.git.dirty && (
            <span className="dirty" role="img" aria-label="есть изменения" title="Есть изменения">
              ●
            </span>
          )}
        </div>
      )}
      {c?.model && (
        <div className="sg">
          модель <b>{modelLabel(c.model)}</b>
        </div>
      )}
      {c && (
        <div className="sg">
          контекст
          <span className={share > CONTEXT_WARN ? 'cbar warn' : 'cbar'} data-testid="context-bar">
            <i style={{ width: `${Math.round(share * 1000) / 10}%` }} />
          </span>
          {/* Как в макете: «84k» и «/200k» — отдельные элементы сегмента (с тем же зазором). */}
          <b>{tokensLabel(c.contextUsed)}</b>
          {`/${tokensLabel(c.contextMax)}`}
        </div>
      )}
      <div className="sg right">{hhmm(now)}</div>
    </div>
  )
}
