import { useEffect, useState, type ReactNode } from 'react'
import { projectName, shortPath, useHome, type GitInfo } from '../status/useGitInfo'

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

// `leading` — место под сегменты Claude (режим, агент, модель, контекст) из плана 3.
export default function StatusBar(p: { cwd?: string; git: GitInfo | null; now?: Date; leading?: ReactNode }) {
  const home = useHome()
  const now = useClock(p.now)
  return (
    <div className="sbar">
      {p.leading}
      {p.cwd && (
        <div className="sg">
          проект <b>{projectName(p.cwd, p.git)}</b>
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
      <div className="sg right">
        {p.cwd && <span>{shortPath(p.cwd, home)}</span>}
        <span>{hhmm(now)}</span>
      </div>
    </div>
  )
}
